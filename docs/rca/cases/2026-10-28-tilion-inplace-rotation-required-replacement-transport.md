---
id: 2026-10-28-tilion-inplace-rotation-required-replacement-transport
date: 2026-10-28
title: Successful same-native Tilion rotation entered replacement-only response hydration
surface: back-end
component: browser-proxy-rotation-response
classification: our-bug
problem_class: other
first_bad_boundary: response assembly required a validation browser after a successful same-native Tilion IP rotation that intentionally opens no second CDP client
symptoms:
  - Logical browser restore requires validated transport
  - live Tilion provider parity
  - rotate-proxy 500 after rotate-ip 200
tags:
  - tilion
  - browser
  - proxy-rotation
  - checkpoint
  - ownership
sources:
  - commit 84bd8a69c2cb8905f542d061a1002771d82d5e86
  - commit 940d216341279dd23fda00003b3d774c576c3de4
  - commit 4c118e0de38c3a0c3f3b1dd93d3b30d89d099608
  - plan: .context/deploy-fresh-20261027/rca-tilion-inplace-response/
  - plan: .context/deploy-fresh-20261027/tilion-inplace-independent-review/
repro: back-end/src/tests/unit/tilion-inplace-response.test.ts
status: open
---

## Problem

The native backend gate on 940d216 had 237 passing blackbox domains and one
failure: live Tilion provider parity returned HTTP 500 from /rotate-proxy after
the provider had rotated the exit on the same native browser. The error was
Logical browser restore requires validated transport. Original producer and
durable evidence remain under
.context/deploy-fresh-20261027/main-sync7/g3-plan/ and
.context/test-runs/backend-coverage-failed-20261028-083600-2781152/.

## Diagnosis

Path: logical proxy rotation -> atomic reservation -> Tilion rotate-ip ->
successful same-native result -> persisted proxy metadata -> logical response
assembly -> unconditional checkpoint-restore transport check. Native evidence
shows request 08:32:17.889 UTC, provider HTTP 200 at 08:32:18.006 with
rotated=true and freshAllocation=true, metadata commit 08:32:18.011, assembly
error 08:32:18.017, and route 500 at 08:32:18.018. Failure begins after the
successful provider operation.

The real in-place adapter intentionally retains the worker's single CDP
client and returns no validationBrowser. The caller nevertheless sent this
positively acknowledged same-native result through replacement-only restore.
Upstream 84bd8a69 has the same adapter and unconditional guard; the reviewed
hydration-owner acknowledgement extension did not introduce this mismatch.

Archive searches were Completed workflow|Logical browser restore requires
validated transport and
duplicate.*signal|signal.*terminal|in.place.*rotation|same.native.*response.
There was no matching Tilion incident. The July 29 browser-context boundary,
September 12 fixture ownership and October 5 terminal fixture cases were read
through Solution and Human feedback as relatives, not causal evidence.

The permanent native unit exercises the real Tilion HTTP adapter and
rotateBrowserProxy against an owned loopback fake REST server. The high-level
provider seam passes the actual adapter result. Unrelated ladder, credentials
and checkpoint dependencies are mocked; no live provider or production DB is
used. The identical command, cwd and test bytes were used before and after:

    node --experimental-test-module-mocks --import tsx /home/boxes/rose/.context/deploy-fresh-20261027/rca-tilion-inplace-response/active/back-end/src/tests/unit/tilion-inplace-response.test.ts

From the repository root, original exit 1 in 0.491 seconds reproduced the
exact transport error. Candidate exit 0 in 0.462 seconds passed 14 controls.
Unchanged fixture SHA-256:
4a05e63751b3854448658af4648354ed0f85fcb908a2f0f05c732aaa5c59b7a8.
Unchanged registered unit SHA-256:
85b7b4703aa7185307492a73a41dcb54f14a04c84812de2ff801764e769fc256.
Reviewed patch SHA-256:
4d94d268700910ed37717bb3cd970f1647b2cd9c52b4776469d61f884cf66a4d.

## Solution

Expose the adapter's existing typed IP-rotation result. Only an acknowledged
Tilion-to-Tilion rotation with both flags true may assemble a same-native
response using existing read-only assembly. Validate the reserved native
session, context, logical owner, provider, ACTIVE state and existing user-control
predicate before and after assembly. Mismatches reject. Missing or unproven
metadata retains the transport-required path. Existing expired-user-lease
behavior remains. Other providers and replacements still use original
validated restore and owned transport close.

The in-place path neither opens/closes CDP nor restores checkpoints, promotes
PAUSED sessions or replays carry snapshots. Reservation SQL was moved verbatim
to the existing helper for the source-size limit, keeping predicates, cap and
parameters; added RETURNING fields bind validation to the reserved row.
Existing resume and response-assembly function bodies are byte-identical.
Read-only assembly retains prior passkey sign-count/credential work: this does
not claim zero database effects.

Fourteen controls cover successful same-native rotation, existing expired-user
semantics, ordinary replacement restore/close, wrong native identity,
missing/unproven proof, reserved-provider mismatch, missing row, context/owner/
PAUSED/USER/user-ownership drift, and drift during assembly. Each in-place
control performs one fake provider POST and zero CDP connects. No original
assertion or timeout was weakened. The new unit is registered with the
existing backend runner; full backend/live parity remain root-owned.

Independent review approved the exact composition fix. Root applied it in
4c118e0. Both child parents were joined; ports 40021 and 43583 were verified
closed and not listening. No database, live provider or financial resource was
created. Original failure receipts remain retained.

This draft stays open pending fresh full owning acceptance on 4c118e0. The
loopback pair is not fresh live-provider, Mac or production acceptance, nor
closure of historical unrelated browser timeouts.

## Human feedback

None recorded for this correction. The standing user request is to finish the existing whole-devbox deployment; no control, provider or ownership waiver was inferred. The coordinator's implementation constraints and independent review are evidence, not human approval.

## Reusable lesson

Distinguish replacing a transport from positively changing its existing native session in place while retaining ownership checks on both paths.
