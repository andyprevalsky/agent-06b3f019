---
id: 2026-11-14-iphone-session-ttl-refresh-discarded-in-progress-setup-checks
date: 2026-11-14
title: A 30-minute phone-harness session refresh during first iPhone setup discarded every verified setup step
surface: back-end
component: iphone-setup-continuity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.setupContinuity.ts configurationAfterConfirmedStop — returned the setup unchanged unless the connection was already ready with a completed configuration, so in-progress proofs kept the old providerEpoch
symptoms:
  - Phone connection is still being prepared
  - phone_connection_not_ready
  - every verification check current:false
  - setup progress reset to portrait_lock
  - connection re-prepared after AutoFill
tags:
  - iphone
  - phone-harness
  - session-expiry
  - provider-epoch
  - setup-verification
sources:
  - PR #2101
  - agent f1802539-7e5d-5a76-9028-133ad4e9fb75
repro: back-end/src/tests/blackbox/iphone-control.continuity.cases.ts "session expiry refresh (in-op|reconciler) during an in-progress first setup keeps verified steps without promoting"
status: fixed
---

## Problem

Prod 2026-11-14, lease c5b5d796 (setup agent f1802539, first-time setup during Gmail Add Account): agent op cursor 167 `screen.text` at 18:37:37.290Z failed `phone_connection_not_ready` ("Phone connection is still being prepared"), and the device providerEpoch went 14 -> 15. Afterwards every setup proof (portrait_lock, apple_account, icloud_messages, icloud_keychain, receive_address all `confirmed`) stayed at providerEpoch 14, so `verificationDto` reported each one `current:false` and the agent saw setup progress reset to portrait_lock. `device_passcode` had already been stranded at epoch 13 by an earlier rollover the same day. The agent then raised request_user_assistance (18:39:55Z).

## Diagnosis

The reset coincided with the agent tapping native iOS "AutoFill" (cursor 166, 18:37:31Z), but the trigger does not matter to the defect. The replacement session (epoch 15) was created at 18:38:03 and expires at 19:08:03, so the harness session TTL is 30 minutes. Op 1 (18:07:37) failed `phone_setup_required`, so the epoch-14 session was created at about op 2 (18:07:43) and expired about 18:37:43. `isFresh` treats a session as stale 10 s before `expiresAt`, so the read at 18:37:37 started the refresh. No log records whether `ensurePhoneSession` took the expiry branch or saw a harness receipt with `cleanup_complete` (which AutoFill could also have caused). Both branches run the same sequence: `closeSessionForRefresh`, then a stop, and `confirmCleanup` increments `providerEpoch` and calls `configurationAfterConfirmedStop`. In prod the stop was not yet confirmed in-op: 167 failed `phone_connection_not_ready` and was recorded at ep14. The interaction-read reconciler (`cleanupPhone`) then confirmed cleanup, raised the epoch to 15 and created the new session at 18:38:03. `configurationAfterConfirmedStop` rebinds current proofs to `providerEpoch + 1` only when `connectionDto(...).status === 'ready'` and a completed configuration is provenance-bound. A first setup is never `ready`, so it returned the setup unchanged, and `proofCurrent` (which requires `proof.providerEpoch === device.providerEpoch`) invalidated every step.

Why was this possible? Continuity (commits d72f77f480 / ab01056598) was designed to protect *completed* configuration across transport stops. The in-progress attempt was left on the default path, even though a same-device control-session stop says nothing new about device settings in either case. Any first setup longer than one 30-minute session loses all its verified steps at each rollover.

## Solution

`configurationAfterConfirmedStop` keeps every existing fence (disabled device, account, owner phone, active private input, observed sign-out). For a not-ready device with no completed configuration, it now rebinds the in-progress attempt's current non-runtime proofs to the next epoch through the same `carryChecks` logic, preserving `observedProviderEpoch`/`observedAt`. Runtime proofs still expire, and nothing is promoted to ready. A re-setup whose device still holds a completed configuration keeps the old behavior (completed path only). That is a known, untested remaining gap, outside this incident. The completed-configuration path is unchanged. Per-device O(checks) work inside the existing device lock, so 10k agents add no fan-in.

Shipped: PR #2101 (merge cae118243454), production lanes PASS. The 2026-11-15 live setup (agent 33712aad) carried its verified steps through to the Gmail sign-in.

## Human feedback

None recorded.

## Reusable lesson

A transport/session epoch bump must carry every in-progress proof that only binds the epoch as a freshness fence, not just completed state; otherwise any long first setup resets at each session TTL.
