---
id: 2026-11-15-iphone-expired-user-lease-left-private-phase-active
date: 2026-11-15
title: An expired user-held phone-auth lease left the device private phase active, so every successor agent operation returned 409
surface: back-end
component: iphone-lease-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.lifecycle.ts closeLease — EXPIRED close of a user-held / pending-auth lease reverts controlOwner to agent but leaves IPhoneDevice.privateInputEncrypted active=true
symptoms:
  - Phone private input is active
  - 409 Phone private input is active
  - lease EXPIRED controlOwner agent privateInputEncrypted active
  - successor agent lease wedged after user phone auth
tags:
  - iphone
  - lease
  - privacy
  - phone-auth
  - attention-request
sources:
  - PR #2261
  - commit 3b5a6e1b20
  - agent 87c1e09a-28ed-5f81-b7ce-6166c18523d7
repro: back-end/src/tests/blackbox/iphone-control.privacy-expiry.cases.ts "expired user-held phone auth lease ends the private phase for the next agent lease"
status: fixed
---

## Problem

Prod 2026-11-15, owner setup agent 87c1e09a, device 462d0c5b. Lease 062f8943 (created 20:55:47Z) paused for native phone-auth (`attentionRequestId phone-auth:a8b530e6…`). The owner took control and typed on the phone, and `claimPrivacy` → `rememberPrivate` set `privateInputEncrypted.active=true`. The owner never handed back. With `leaseExpiresAt` 21:04:28Z plus the 15 min user grace, the lease went EXPIRED at 21:19:48Z (prod row: status EXPIRED, controlOwner agent, attentionRequestId still set). After resuming at 21:40Z the agent got lease 661ab268, and every agent operation got `409 Phone private input is active` (72 failed steps over 25 min; none persisted as operation rows because admission refuses before the row). The coordinator unwedged it by having the user call control user→agent on the new lease.

## Diagnosis

Critical path: user `input.text` → `claimPrivacy` sets active → `reconcileActive` → `expireHold(userHeld=true)` → `closeLease(…, 'EXPIRED')` sets controlOwner=agent → `admit` promotes the successor → successor agent op → `claimPrivacy` sees active → 409.

First bad boundary: `closeLease`. It ends the user's control (controlOwner→agent) on grace expiry but leaves the device private phase, which belongs to that user control, active. The only paths that clear it are user handback (`mutate` → `resumePrivacy`), native attention completion, the saved-credential path and connect with no holder. Expiry is none of these, so the phase outlives every holder.

Why possible: the 2026-10-18 privacy policy ("Only authenticated USER handback may clear phase") predates the bounded user-control grace. Later commits (dcd4c57fcc, PR #2123) made the system end user-held holds on its own, but never defined what happens to the private phase when the system rather than the user ends that control.

Archive searches: `rca_archive.py search "Phone private input is active lease expired privacy"`, `search "privateInputEncrypted active resumedPrivacy user control"`, `grep -ril "private input is active" docs/rca/cases/` (no hits). Relatives: 2026-11-15-iphone-paused-agent-released-lease-before-pending-phone-auth, which introduced the bounded grace this case extends (its lesson applies: the grace is the bound on the owner's hold, so everything the hold owns ends with it), and 2026-10-18-phone-unregistered-private-input-result-disclosure (source of the handback-only policy, narrowed here to expiry only). Novel defect, not a recurrence.

## Solution

`closeLease` (`back-end/src/domains/iphone/repo.lifecycle.ts`) now ends the private phase when an ACTIVE lease that is user-held or pending phone auth closes EXPIRED (its user grace lapsed), but only if that lease opened the phase. The privacy envelope (`back-end/src/providers/phoneInputPrivacy.ts`) gains an optional `leaseId`, set on the inactive→active transition only by user-opened phases: user `input.text` through `claimPrivacy`, and the native attention write (`openedBy`). Agent-opened phases (passcode and saved-credential fills) and legacy envelopes carry no opener, so expiry never ends them. `expiredPrivacy` sets `active=false` and keeps every vaulted value, so redaction is unchanged. `lockedDevice` re-reads the envelope after `reconcile`, so the request that triggers the expiry sees the committed phase.

Deliberately unchanged: an explicit user release, CANCELLED closes, auth rejection, and phases inherited from an earlier lease still need an authenticated user handback, per the 2026-10-18 policy. Those closes are immediate and in part agent-triggerable. Only the bounded 15-minute grace, during which the user did nothing, ends a phase without the user. A successor agent cannot clear an inherited phase by flipping itself to user control and idling. A malformed envelope is logged (`expiry left unreadable private phase`) and left untouched, so the lease lifecycle still advances; privacy checks keep failing closed on it. Expiry does not answer the attention request or advance setup state, because the user never completed it.

Not fixed by this case (remaining gap): a successor after a release or cancel of a private lease still gets 409 until the owner hands back. Nothing prompts the owner to do that.

10k behavior: two PK reads per close and one PK read per `lockedDevice` under the existing device lock; no fan-in.

Regression: `iphone-control.privacy-expiry.cases.ts` (prod path through native attention, plus a negative control inside the grace) an inherited-phase case, and an agent-opened-phase case. Command `cd back-end && bash scripts/run-blackbox-tests.sh iphone-control`: before the fix exit 1, 180/181, `Successor agent wedged after user lease expiry: {"error":"Phone private input is active"}` (both negative controls pass on buggy code); after the fix the three new cases passed in 5/5 consecutive runs (181/181 four times; one run hit an unrelated live-model miss in `live setup verifier: recorded proof screens and controls`, whose runtime import graph reaches none of the changed files). Neighbour domains iphone, iphone-interactions, iphone-rls and auth-assistance pass.

Golden reference: not applicable (no approval-gated hunk; deploy freeze guards clear).

Shipped: PR #2261, merged 3b5a6e1b20; Render live 2026-11-16T00:21:06Z; production lanes render, backend-probes and semantic PASS. Phases opened before the deploy carry no leaseId and still need one user handback.

## Human feedback

An independent reviewer found that the v1 condition (any user-held or pending-auth expiry) let an agent clear an inherited phase by setting control to user and idling, and that a malformed envelope would wedge `reconcile`. v2 binds the phase to the lease that opened it. The second review found that agent-side passcode fills would still bind an opener; v3 records an opener only for user-opened phases and logs the malformed skip. The coordinator specified the policy space: clear or deactivate privacy when the user-controlled lease expires or closes, or when a new agent lease is acquired after the attention lease ended, while keeping submitted-value redaction.

## Reusable lesson

When the system ends a user-held phase on a timeout, end every piece of state that phase owns in the same transaction, or the next holder inherits a lock nobody can release.
