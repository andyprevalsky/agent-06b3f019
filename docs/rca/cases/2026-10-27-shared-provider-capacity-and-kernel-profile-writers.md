---
id: 2026-10-27-shared-provider-capacity-and-kernel-profile-writers
date: 2026-10-27
title: E2B capacity refusals failed code agents, and every concurrent browser of a user wrote one Kernel profile
surface: back-end
component: browser-provider
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/e2bSandboxCreate.ts treated an E2B RateLimitError (HTTP 429 over the concurrent-sandbox cap) as fatal; back-end/src/providers/browser/kernel.ts created every browser on the user's shared profile with save_changes: true"
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
  - commit 5cf8340c9
repro: back-end/src/tests/unit/scale-e2b-capacity-wait.test.ts, back-end/src/tests/unit/scale-kernel-profile-writer.test.ts
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

1. `scale-e2b-capacity-wait.test.ts`: `Sandbox.create` refuses twice with
   `RateLimitError`, then succeeds. Buggy revision: `not ok 1` (first refusal
   thrown). Fixed revision: pass. Non-opted-in callers still fail fast.
2. `scale-kernel-profile-writer.test.ts`: the buggy `kernel.ts` hard-codes
   `save_changes: true` (assertion failed). With the fix, 10 concurrent creates
   on one profile produce exactly one writer. Release, handoff, failed-swap
   restore, failed-bind cleanup and dead-writer takeover are also covered.

## Solution

- `e2bSandboxCreate.ts`: callers opt in to waiting for E2B capacity. The
  typed SDK classes `RateLimitError` and `ServiceBusyError` then wait for a
  slot, backing off from 2 s up to 10 s. Only the code-agent create
  (`e2bCodeSessionSandbox.ts`) opts in, within `E2B_CAPACITY_WAIT_MS` (default
  30 s, inside the agent's 60 s create request). The caller therefore never
  gives up and retries while the backend is still waiting. Synchronous user
  paths (user tools, code inspections) keep failing fast. A refusal creates no
  sandbox, so waiting cannot orphan one.
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
one failed insert and one read. The E2B wait holds no shared state. Nothing
grows with the total number of agents, users or instances.

## Human feedback

The parent split this PR off from the approval-gated per-user cap (PR #1595).

## Reusable lesson

When a provider has state that only one writer may persist, claim the writer
role before creating the resource. Release it only after the provider has
persisted that state. For provider capacity, admit on the provider's own
typed refusal and wait for a slot. A DB mirror of provider concurrency can
drift and then wedge every user.
