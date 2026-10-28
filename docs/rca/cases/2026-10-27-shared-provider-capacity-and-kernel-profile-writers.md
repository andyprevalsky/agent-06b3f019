---
id: 2026-10-27-shared-provider-capacity-and-kernel-profile-writers
date: 2026-10-27
title: E2B capacity refusals were an untyped generic failure, and every concurrent browser of a user wrote one Kernel profile
surface: back-end
component: browser-provider
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/e2bSandboxCreate.ts let an E2B RateLimitError (HTTP 429 over the concurrent-sandbox cap) surface as a generic create failure that the agent soft-failed as transient; back-end/src/providers/browser/kernel.ts created every browser on the user's shared profile with save_changes: true"
symptoms:
  - "Rate limit exceeded, please try again later (E2B RateLimitError) failing the code-agent spawn on the first refusal"
  - "Only one browser can safely write to a profile at a time (Kernel docs); every concurrent browser was created with save_changes: true"
tags:
  - scalability
  - 10k-agents
  - admission-control
  - kernel
  - e2b
sources:
  - memory:scalability-audit-100-seats-20261024
  - PR #1587
  - PR #1601
  - commit 5cf8340c9
repro: back-end/src/tests/unit/e2b-capacity-fail-fast.test.ts, agents/tests/blackbox/code_agent_e2b_capacity.blackbox.py, back-end/src/tests/unit/scale-kernel-profile-writer.test.ts
status: fixed
---

## Problem

The 2026-10-24 100-seat audit (lane C, S19) found two shared-provider gaps.
Both were re-verified on main `31d769b90`:

- E2B caps concurrently running sandboxes per team (Hobby 20, Pro 100, add-ons
  600/1,100). Over the cap the SDK raises `RateLimitError` (HTTP 429), or
  `ServiceBusyError` (503) when busy. `isTransientSandboxCreateError` retries
  neither, so the code agent failed on the first refusal. `e2bCreateSlot.ts`
  only serializes creates within one process.
- Every Kernel browser of a user loads the single per-user profile
  (BrowserContext is unique per user) with `save_changes: true`. Kernel's docs
  say: "Only one browser can safely write to a profile at a time" and
  "Saving replaces the complete profile; it doesn't merge state from multiple
  browsers." The last browser to be deleted silently overwrote the sign-ins
  the others had saved.

Kernel's concurrent-browser cap (Free 5, Hobbyist 10, Start-up 150) already has
a protective path. Its 429 maps to `BrowserProviderRateLimitError`, and the
worker shows "Waiting for browser availability" for up to 900 s. That path is
unchanged. The per-user root-agent cap from the same audit lane is tracked in
PR #1595 (pending product approval of the limit).

## Diagnosis

Provider facts: https://www.kernel.sh/docs/browsers/profiles,
https://www.kernel.sh/pricing, https://e2b.dev/pricing (fetched 2026-10-27).
Neither API exposes which plan the account is on.

Step 0.5: no merged or open PR limits Kernel profile writers or retries E2B
capacity refusals. `5cf8340c9` ("logical browsers keep their Kernel profile")
made rotate/resume reuse the bound profile; it did not limit writers.

Local repros (local Postgres, never prod):

1. `e2b-capacity-fail-fast.test.ts`: `Sandbox.create` refuses with
   `RateLimitError`. On the buggy revision 3 of 4 cases fail: no typed
   error, no alert, no 503 mapping. With the fix, exactly one create attempt
   is made, the error is the typed `E2BSandboxCapacityError` with the exact
   message, one throttled #errors alert fires, and routes answer
   `503 E2B_CAPACITY_EXHAUSTED`.
   `code_agent_e2b_capacity.blackbox.py`: the agent-side create maps that 503 to
   a non-retryable typed error. The tool fails with the message verbatim, with
   no retry and no "transient capacity" soft-fail. Both cases fail on the buggy
   revision.
2. `scale-kernel-profile-writer.test.ts`: the buggy `kernel.ts` hard-codes
   `save_changes: true` (assertion failed). With the fix, 10 concurrent creates
   on one profile produce exactly one writer. Release, handoff, failed-swap
   restore, failed-bind cleanup and dead-writer takeover are also covered.

## Solution

- `e2bSandboxCreate.ts` (as directed by Andy, 2026-10-27): E2B capacity is
  never waited on or queued, so the shortage stays visible and the plan gets
  scaled.
  - A `RateLimitError` from E2B fails at once with `E2BSandboxCapacityError`:
    "E2B concurrent-sandbox limit reached: every sandbox allowed by the current
    E2B plan is in use, so no new sandbox can start. Scale the E2B plan to run
    more code agents."
  - Each occurrence logs that message and calls `alertError` (source
    `e2b_capacity`). Its existing per-signature 5-minute throttle keeps
    #errors to one card per window.
  - Code-session create routes (Claude and Codex), user tools and code
    inspections answer `503 E2B_CAPACITY_EXHAUSTED` with the same message.
  - The code agent fails the tool call with it verbatim, as a non-retryable
    error that is never soft-failed as a transient retry.
  - The interim `E2B_CAPACITY_WAIT_MS` wait from #1601 is removed.
- `browser/kernelProfileWriter.ts`: before a create, the browser claims the
  per-profile writer row in `SharedEphemeralState`. The winner gets
  `save_changes: true`. Other concurrent browsers load the profile without
  saving, and `BrowserSession.providerProfilePersist` records which role each
  browser has.
  - A rotate/resume replacement inherits the writer role. The row moves only
    when the replacement binds. If the swap fails, the role returns to the
    still-live replaced browser.
  - If recording the bind fails, the new browser is deleted, so an untracked
    writer cannot remain.
  - `releaseKernelRemoteSession` frees the claim only after the DELETE, which
    is when Kernel saves. A bookkeeping error never turns a successful delete
    into a failure.
  - If a writer vanished without a release, one Kernel GET detects it, and that
    GET runs only on the contended path. The 72 h TTL (Kernel's maximum
    session lifetime) is a backstop.

Scale (10k agents): each writer browser uses 2 primary-key rows. A reader uses
one failed insert and one read. The E2B failure path holds no shared state. Nothing
grows with the total number of agents, users or instances.

## Human feedback

The parent split #1601 off from the per-user cap (PR #1595), which Andy
rejected. Andy then directed that E2B must fail with a clear error when
capacity runs out, with no waiting or queueing, so the plan gets scaled.

## Reusable lesson

When a provider has state that only one writer may persist, claim the writer
role before creating the resource. Release it only after the provider has
persisted that state. For provider capacity, act on the provider's own typed
refusal (not a DB mirror, which drifts), and make the shortage loud: a typed,
non-retryable error carrying the exact message, plus a throttled alert.
