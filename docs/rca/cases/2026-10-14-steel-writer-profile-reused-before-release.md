---
id: 2026-10-14-steel-writer-profile-reused-before-release
date: 2026-10-14
title: Steel rotation tried to reload an uploading profile before releasing its writer
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/sessionResume.ts recreateSession created a replacement with the old live writer's persistent profile, while the outer wrapper deferred releasing that writer until replacement succeeded
symptoms:
  - "409 Profile 'b033c9de-61e1-4af3-a703-fe6ef02fafac' is still uploading and cannot be attached to a session yet"
  - 'Failed to create Steel replacement after 5 attempts'
  - 'FAIL live Kernel provider parity: /rotate-proxy 500'
tags:
  - steel
  - browser-profile
  - profile-readiness
  - rotate-proxy
  - lifecycle
sources:
  - PR #1511 deploy gate 2026-10-14
  - task backend-coverage-failed-20261014-210438-2262201
repro: back-end/src/tests/blackbox/steel-fingerprint.profile-handoff.behavior.ts
status: fixed
---

## Problem

The full backend coverage run failed `browser-provider` after 197995 ms. Its
Kernel parity test had already rotated residential and mobile proxies and
successfully switched to Steel. The final Steel-to-Steel rotation failed four
outer requests, each exhausting five creates with the same profile-uploading
409. The first request began at 20:55:16Z and the last failed at 20:56:46Z.
The complete original server log is retained in
`.context/test-runs/backend-coverage-failed-20261014-210438-2262201/server.log`.

## Diagnosis

Critical path: `/rotate-proxy` reserves a recovery step, `rotateProxy` calls
`recreateSession`, the latter reloads the recorded Steel profile and creates a
replacement, then the outer wrapper releases the previous remote session.

At 20:55:09Z the task committed Steel session
`69148be2-fc59-4d77-b168-cc8eafda433e` with persistent profile
`b033c9de-61e1-4af3-a703-fe6ef02fafac`. At 20:55:17Z the next rotation tried
to attach that same profile while its writer was still live. Every create
returned 409. Steel's native lifecycle saves a writer's profile after release
and marks it READY after upload; preserving that writer until replacement
success therefore formed a circular dependency. No amount of create retries
could complete the prerequisite release.

A read-only SDK check after fixture cleanup found that exact profile READY,
with `sourceSessionId` equal to the original writer, and the writer released
with `releaseReason: user_requested`. The provider was preserving state
according to its contract, rather than suffering an unexplained outage.
The deeper owned cause was applying overlap-before-release replacement to a
resource whose successor requires its predecessor's finalized artifact.

Archive searches were `Profile is still uploading cannot be attached Steel
rotate-proxy` and `proxy rotation persistent browser profile readiness release
reuse`. The closest Steel startup-failure and Kernel proxy-reuse cases have
different first bad boundaries; this is a new case.

Golden references: Steel's [session configuration](https://docs.steel.dev/overview/sessions-api/configuration)
requires release, native profile READY, then reuse. The installed SDK's
`steel-sdk/src/resources/profiles.ts` exposes UPLOADING, READY, and FAILED.
OpenClaw's `extensions/browser/src/browser/server-context.lifecycle.ts:535`
awaits owned cleanup before its successor callback at line 543. Searches of
Claude Code, Hermes, and Codex found no Steel profile-persistence analogue;
Hermes' desktop lease is a different control-ownership contract. The common
applicable principle is to finish a resource's lifecycle prerequisite before
admitting the dependent operation.

## Solution

For a session-bound persistent Steel writer, replacement releases only its
captured previous session ID, records the retained binding as resumable PAUSED,
and queries the exact profile's native status before creating the successor.
Readiness shares the existing five-attempt backoff budget; terminal FAILED
stops immediately. Read-only snapshots, fresh-profile recovery, and other
providers retain their existing behavior. The existing final binding CAS
continues to reject and release an uncommitted loser.

Permanent owning-boundary reproduction:

```text
cd back-end
bash scripts/run-blackbox-tests.sh steel-fingerprint
BEFORE: 5 creates return 409; writer handoff test FAIL
AFTER: release writer -> UPLOADING -> READY -> one create, same profile
```

The pre-fix artifact is `.context/steel-profile-handoff-before.txt`. With the
candidate, the unchanged live `browser-provider` domain passed in 114545 ms
and the owning `steel-fingerprint` domain passed in 12624 ms, two domains and
zero failures (`.context/steel-profile-handoff-after-live.txt`). Its live
rotation observed UPLOADING twice, then reused the same profile successfully
at 21:09:39Z. Additional owning cases cover failed release, failed profile,
failed create, a competing committed replacement, and idempotent remote 404.
The final owning run including those controls passed in 16529 ms
(`.context/steel-profile-handoff-final.txt`).
Independent adversarial review confirmed the causal boundary, retained failure
custody, exact-session cleanup, and preserved final CAS, with no blocker.

At 10000 agents the change adds at most five exact-profile reads per affected
handoff, with no profile-list scans, shared-resource deletion, extra session
allocation, new retry loop, or expanded timeout. A failed dependent create
retains the original profile and resumable row instead of discarding auth.

## Human feedback

None recorded.

## Reusable lesson

Finalize the captured writer and verify its artifact's native readiness before creating a successor that must reuse that artifact.
