---
id: 2026-10-16-configured-fresh-failure-skipped-billing-stop
date: 2026-10-16
title: Configured fresh failure or cancellation bypassed billing STOP
surface: infra
component: cloudbench-billing-stop
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: billing native-pair validation rejected a provenance-bound configured boot before its current quiescence probe
symptoms:
  - "unsupported inert config"
  - "BILLING_STOP_REFUSED"
tags:
  - cloudbench
  - teardown
  - cancellation
  - billing
sources:
  - PR #1525
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BillingStopRetainTests
status: fixed
---

## Problem

After failure or cancellation, the controller keeps Machines and their data
when runtime evidence cannot be collected. Its billing helper can stop an exact
inert fresh allocation, but rejects a configured `bash /cloudbench-boot.sh`
allocation before probing current quiescence. Consequently an unused Machine
can remain running even though ownership is known and no pool admission is
being requested.

## Diagnosis

The first refusal is the native-pair check requiring `sleep infinity` and empty
environment. The existing local fixture reproduces the boundary: changing only
init and task environment gives PENDING with no guest probe or STOP. The final
two positive configured-boot cases both fail against unchanged `50acb1ee1`.
The related claimed-pool missing-evidence and fresh-primary pool-return RCAs
address different branches and do not authorize weakening pool admission.

## Solution

Preserve the exact inert path. For configured fresh allocations, require the
original boot command, canonical validated execution provenance and task matrix,
exact clone MID, current runtime owner, source REF and owner-derived task run
token. Bind the separate barrier credential to the current cleanup caller's
environment; it is not the owner-derived task token. Read original evidence with
the existing bounded no-follow reader, record its hashes privately, and recheck
those same bytes throughout the operation.

Keep all original live-owner, claim, native identity, config, Volume, deadline,
once-intent, process-quiescence and observed-STOPPED gates. The helper changes no
configuration and releases no claims or data. Unknown live processes, foreign
source/tokens, source drift, missing ownership, and unjoined producers still
refuse. No runtime evidence or pool credit is granted by physical STOP.

## Verification

Six new registered cases passed five consecutive unchanged runs. The complete
19-case billing family passed after the final change. Tests use the real helper,
local custody files and timers with only provider transport/PID boundaries
mocked. Cases cover STOP with original bytes preserved, source/token/task
refusals, unknown processes, post-probe source drift, already-stopped custody,
missing or malformed originals, and unjoined/foreign callers. The existing
inert path and deadline/once-only cases remain covered. No provider or guest
operations were performed; live qualification remains root-owned.

## Human feedback

The user requires failed or cancelled unused Machines to stop and be observed
STOPPED while preserving IDs, Volumes, data, claims, latches, protected capacity,
and Freedom.

## Reusable lesson

A failed evidence copy must retain evidence custody, not automatically running
compute. Extend the exact stop authority only with current task provenance and
current quiescence; never use that stop result to infer evidence admission.
