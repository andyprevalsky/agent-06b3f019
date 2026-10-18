---
id: 2026-10-16-fleet-proof-signal-parser-exit-without-first-delivery-trace
date: 2026-10-16
title: Fleet proof signal fixture exited with parser errors before exact recovery
surface: harness
component: fleet-stability-cleanup
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: The retained signal fixture observed its proof shell exit before the exact recovery command was called; the original first-signal delivery and parser state were not captured
symptoms:
  - "failed proof abandoned exact cleanup obligation"
  - "unexpected EOF while looking for matching"
  - "process substitution: line 617"
tags:
  - fleet-proof
  - signal
  - cleanup
sources:
  - commit b5d81c3e240c1349439c99dab00c3ea77631e76c
  - task .context/deploy-runs/main705-b5d81c3e2-qualification-20261016/A-FAILURE-RECEIPT.json
  - task .context/test-runs/fleet-proof-test_signal_waits_for_owned_producer_before_recovery-97jeu3ju/fixture/output.log
repro: python3 scripts/tests/fleet-stability-cleanup.test.py FleetFailureCleanup.test_signal_waits_for_owned_producer_before_recovery
status: open
---

## Problem

The normal native controller stage failed at 2026-10-16T13:02:13Z in
FleetFailureCleanup.test_signal_waits_for_owned_producer_before_recovery.
The unchanged assertion at fleet-stability-cleanup.test.py:493 expected one
exact recovery call but observed zero. The retained calls file contains only
fleet e666e8ee4c7c4c6fa7af802337817e7d. Output reports the proof script's trap
line 2 and process-substitution line 617 as unexpected EOF while looking for
matching closing parenthesis. The proof then reports its first slice failed.
The stage exited one; later native commands did not run. Earlier source-bound
passing stages do not discharge this failure.

## Diagnosis

The actual path is fixture readiness publication, SIGTERM to its unreaped proof
Popen, outer forward_proof_cancellation, exact active waiter, tracked detached
producer group drain, and recover_proof_slice's exact durable recovery call.
Source line 617 validates tracked identity before the log relay and canonical
waiter; the diagnostic alone does not prove the exact executed instruction.
The diagnostic is evidence
of shell parsing failure, not proof of its cause. No trace captured the first
signal's actual delivery, native pending/disposition state, parser execution,
or ordering relative to command/process substitutions. Do not attribute it to
load, source mutation, Bash, repeated signals, or a provider without causal proof.

In a new detached checkout of the exact failed source, the exact repro command
above passed unchanged in 2.626 seconds. A separate test-only experiment attempted up to
300 additional SIGTERMs to that fixture's same unreaped Popen while retaining
its original recovery assertions; it also passed in 2.627 seconds. The loop
stopped if the process exited and recorded no delivery counter, so the actual
delivered signal count is unknown. That experiment
was saved privately and removed from the proposed source. Neither pass proves
what happened in the original failure. No deterministic causal RED was found.

Archive searches used literal unexpected EOF/matching/process substitution/trap
and behavioral failed proof/abandoned/retained fleet/cancellation vocabulary.
The September 11 failed-stability-proof-abandoned-retained-fleet case describes
the same ownership subsystem and completed fixes, and its own distinct open
completion-reader observation. The July 14 mutable-shell-script case and
October 5 fixture-deadline case are leads only: this incident has no proven
matching cause and no bound is changed. Process feedback was read before any
repair proposal. A causal recurrence is not established, so this open observation
does not overwrite those earlier diagnoses.

## Solution

No runtime or fixture repair is proposed. The RCA remains open. Preserve the
original private fixture tree, output, calls, owner records, source hashes and
stage receipt. Obtain a controlled owning-boundary failure with first-signal
and parsing evidence before changing production cancellation behavior. Keep the
same cleanup count, group-drain, identity, recovery and deadline assertions.
Do not mark the gate passed from a focused pass or add a retry waiver.

One subsequent complete unchanged native-controller attempt at the same b5
source passed on 2026-10-16 from 13:09:34Z to 13:38:35Z (1741.6 seconds):
27 stability-cleanup tests, all 16 multi-workstream scenarios and subcases,
17 Linux tests, 21 wall-clock tests, and 505 focused tests (593 deselected).
Its exact observed owners, listeners and status container retired and 392
controller input hashes had no drift. This is complete-gate requalification,
not evidence of a causal fix. The original failure and this RCA remain open.
The source-bound receipt is
.context/deploy-runs/main705-b5-native-retry-20261016/A-FINAL-RETRY-RECEIPT.json
(SHA256 d3c21da34e559ed9ddf028daf08beb890cf84d76d1b5211c77cc1eb2ac593a43).

The original fixture's normal finally cleanup ran. The recorded proof, waiter,
producer, command and fake registry PIDs 3828953, 3828980, 3828990, 3828996,
3828997 and 3828998 were absent after join. The fake owner registry remains as
failure evidence; it denotes no live provider resource. The exact offline status
container and both seed measurement databases were also absent. No broad cleanup,
provider calls, environment writes or production actions occurred.

## Human feedback

None recorded.

## Reusable lesson

Capture first-signal delivery and the exact shell execution boundary before attributing a cancellation cleanup failure to parser timing or declaring it fixed.
