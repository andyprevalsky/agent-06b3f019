---
id: 2026-11-15-iphone-new-lease-attempt-id-discarded-in-progress-setup-proofs
date: 2026-11-15
title: Re-acquiring the phone lease mid first setup minted a new setup attempt id and discarded every verified step
surface: back-end
component: iphone-setup-continuity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.setup.ts ensureSetup — a new lease for the same connection reservation's setup actor replaced state.attempt (new id, floorCursor, floorAt) without rebinding the in-progress proofs, so proofCurrent rejected each on attemptId/floorCursor/floorAt
symptoms:
  - portrait_lock back to in_progress
  - apple_account pending after lease re-acquire
  - setup progress reset on new lease
  - verification check current:false after owner auth pause
  - New lease discarded verified portrait_lock
tags:
  - iphone
  - phone-lease
  - setup-attempt
  - setup-verification
  - attention-floor
sources:
  - agent 1772a64a-c22a-5cf7-9184-17508eda5df6
  - PR #2123
  - PR #2225
repro: back-end/src/tests/blackbox/iphone-control.setup.cases.ts "same setup actor on a re-acquired lease keeps verified first-setup steps without promoting"
status: fixed
---

## Problem

Prod 2026-11-15, setup agent 1772a64a (the connection reservation's own actor, revision 108), first-time setup for user 1f85ff25. Lease 45543f2e ran from 05:22:27 to 06:00:22Z, and lease 7c1dd8c6 started at 06:02:07Z. Both had the same agent, workflow and browser task 1185d95b. After the re-acquire, `GET /api/iphone/connection` showed setup steps back to in_progress or pending. A read of the device setup state showed the current attempt bound to lease 7c1dd8c6. Every stored proof except the 06:04:41 gmail proof had `attemptId != attempt.id`. That included portrait_lock (confirmed 05:31:17) and apple_account (confirmed 05:33:19). Lease 1 had SUCCEEDED `setup.verify` operations at 05:55:57 and 06:00:02, and gmail was verified again on lease 2 at 06:03:08 and 06:04:38.

## Diagnosis

`ensureSetup` starts a new attempt whenever the active lease differs from `state.attempt.leaseId`. The new attempt gets `id = setupIdentity(lease.id, claimRevision)`, `floorCursor = lease.actionCursor` and `floorAt = now`. `proofCurrent` binds every proof to `attemptId`, `workflowId`, `floorCursor` and `observedAt >= floorAt`, so every in-progress proof from the earlier lease went `current:false`. Only a ready setup survived, through `completedConfiguration`. PR #2123 (case 2026-11-14) carried in-progress proofs across a confirmed same-device stop within one lease (the providerEpoch fence), but not across leases (the attempt fence). Repro, identical command before and after: `bash scripts/run-blackbox-tests.sh iphone-control`. On main 78969c1eb1 it was RED 175/176, with `FAIL same setup actor on a re-acquired lease ...: New lease discarded verified portrait_lock`. With the fix it was GREEN 176/176.

A second, intentional fence also fired in this incident. Two owner native phone-auth attentions completed on lease 1, at 05:49:45 and 05:54:40Z. `completeNativePhoneAttention` calls `setupAfterAttention`, which moves the attempt floor to the completion time because the user had control of the phone. That had already made the 05:31 and 05:33 portrait_lock and apple_account proofs stale before the re-acquire, by design. The cross-lease reset then also discarded the proofs verified after that floor on lease 1 (05:55, 06:00), which forced the repeated verifies at 06:03 and 06:04. This fix does not weaken the attention fence, and a regression asserts that it still holds across a lease change.

Why was this possible? The attempt id was doing two jobs: fencing one lease's command custody, and owning the reservation's setup evidence. A routine lease handoff for the same actor (a pause, owner auth or grace expiry, then a re-acquire) therefore looked like a new setup.

## Solution

When the new lease belongs to the same reservation's actor, `ensureSetup` rebinds the earlier attempt's still-current non-runtime proofs to the new attempt (`attemptId`, `workflowId`, `floorCursor`). "Same actor" means `currentConnection` agent equals the lease agent and the earlier attempt's agent, with the same browser task, workflow id and first execution run, the same expected phone, and not `observed_signed_out`. The rebind keeps `observedAt`, `providerEpoch` and `observedProviderEpoch`, and records the new floor in a new `carriedAt` field. `proofCurrent` compares the later of `observedAt` and `carriedAt` against the floor. The independent review caught that an ordering check (`carriedAt >= observedAt`) in `validSetupChecks` would have made the setup state unreadable (409) once a later sign-out rewrote `observedAt`. That check was removed, and a regression signs out after a carry. A proof that was stale on the earlier lease (attention floor, epoch change, profile change) is never revived. A later attention floor still invalidates carried proofs, and the runtime proof is always dropped. A different agent, workflow or run, a reconnect (which deletes `state.attempt`) or a ready configuration takes the old path. The work is O(checks) per device inside the existing transaction, with no fan-in at 10k agents.

Regressions in `iphone-control.setup.cases.ts`: the same actor on a new lease keeps its proofs, is not promoted, and stays readable after a later sign-out; another agent, or the same agent on a restarted execution run, starts fresh; and an attention-floor-stale proof stays stale on the new lease.

Shipped: PR #2225 (merge 37308b16bd974838258f5ca8485471da73c708b5). Production lanes passed: Render was live on the merged SHA, backend probes and the log scan were clean, and production semantics passed (2026-11-15 19:2xZ). The live phone was not touched, and Connect was not called. A live proof is still pending the owner's next setup re-acquire.

## Human feedback

None recorded.

## Reusable lesson

A per-lease custody identity must not double as the owner of a reservation's setup evidence: when the same actor re-acquires, rebind still-current proofs to the new attempt and keep every freshness fence, otherwise each lease handoff resets setup.
