---
id: 2026-10-16-fleet-proof-signal-parser-exit-without-first-delivery-trace
date: 2026-10-16
title: Fleet proof signal fixture exited with parser errors before exact recovery
surface: harness
component: fleet-stability-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-fleet-infra-stability-proof recover_proof_slice parses a command substitution in the cancellation waiter while TERM can re-enter that parser
symptoms:
  - "failed proof abandoned exact cleanup obligation"
  - "unexpected EOF while looking for matching"
  - "process substitution: line 617"
  - "process substitution: line 1007"
  - "trap: line 2: unexpected EOF while looking for matching"
tags:
  - fleet-proof
  - signal
  - cleanup
sources:
  - PR #1770
  - commit b544c29434ccbb5075952850b7701ffec14545c9
  - commit b5d81c3e240c1349439c99dab00c3ea77631e76c
  - PR #1921
  - commit b380b1eae733dec70c4409d6ce9aa658ffe4f587
  - task .context/deploy-runs/main705-b5d81c3e2-qualification-20261016/A-FAILURE-RECEIPT.json
  - task .context/test-runs/fleet-proof-test_signal_waits_for_owned_producer_before_recovery-97jeu3ju/fixture/output.log
repro: python3 scripts/tests/fleet-stability-cleanup.test.py FleetFailureCleanup.test_repeated_waiter_cancellation_keeps_exact_cleanup
status: fixed
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

### Original investigation — October 16, 2026

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

### Recurrence and causal capture — November 7, 2026

PR #1770's isolated Blacksmith structural run 42411735341 reproduced the
unchanged permanent FleetFailureCleanup.test_signal_waits_for_owned_producer_before_recovery:
expected one recovery, received zero, with trap line 2 / process substitution
line 548 reporting the same unexpected EOF. The owning scripts tree is
identical between base 20f6e41f2 and failed b544c2943, establishing
Gate: NOT_INTRODUCED for the duration repair; the incomplete aggregate remained
blocking and was repaired in this deploy.

An independent investigator reduced the failure to the actual
recover_proof_slice body on Bash 5.2.21. A controlled native schedule delivered
one TERM to the recovery waiter at expansion of its canonical
cloudbench_process_group_state probe. Original code: trigger true,
probe_in_waiter true, exit 2, exact unexpected EOF and no recovery. With the
one-line pipeline candidate, the identical canonical-probe schedule still
triggers and targets that same waiter; expansion occurs in the pipeline child,
and recovery completes with exit 0. These observations close the earlier
first-delivery/parser-boundary gap. They do not establish that every historical
failure had the same receipt order.

The optional full-native-fixture harness itself reported ChildProcessError on
residual child accounting in both modes. It is NOT cited as a clean whole-test
pass. A later instrumentation attempt was stopped by automatic security review;
no further native instrumentation was performed. The ordinary unchanged full
33-test fleet-stability-cleanup suite passes on the applied production fix
(32.316 seconds). The original CI failure, focused causal fail/pass and ordinary
whole-suite outcome are separate evidence. The existing permanent test already
owns this exact cancellation/recovery boundary; its assertions and deadlines
are unchanged and the deploy structural runner continues to execute it.

### Second recurrence — November 12, 2026

PR #1921's Blacksmith structural run 43288783754 (source b380b1eae7, which
already contains the November 7 fix) failed the unchanged
FleetFailureCleanup.test_cancellation_does_not_depend_on_body_pid_probe once
(FLAKY 6a8453c3ef3b46a08607ecdf27b9dcdc): `0 != 1 : failed proof abandoned
exact cleanup obligation`, with cloudbench-env.sh `trap: line 2` and
`process substitution: line 1007` unexpected EOF. Line 1007 is the waiter's
`pgid="$(cloudbench_tracked_owner_value ...)"` prologue read. The retained
fixture shows calls with only the fleet line, slice-0.cleanup.json still
`pending`, and the slice later SIGKILLed by the test's own finally cleanup.
The fixture file was not truncated: the "EOF" is Bash's own parse of the
substitution text.

Why the earlier fix did not hold: it converted only recover_proof_slice's
probe. forward_proof_cancellation runs every 0.1 seconds and re-sends the
signal to the published waiter for the waiter's whole life, so every
`$(...)`/`<(...)` executed by that process is a target: the
run_owned_proof_slice owner reads and log-relay process substitution after
publication, and every owner read, group-state probe, `$(seq ...)` and
cloudbench_pid_matches_start inside cloudbench_wait_tracked_detached.

Mechanism, reduced (Bash 5.2.21): a subshell with `trap ':' TERM` looping on
`x="$(f)"` while only that PID receives TERMs prints exactly
`trap: line 2: unexpected EOF while looking for matching `)'` and
`process substitution: line N: ...`, and the trapped shell itself exits: no
later statement in or after the function runs, so `|| true` guards cannot
contain it. The CI evidence matches: no `FATAL: detached ownership handshake
is malformed` line (an empty read would print it), slice-0.cleanup.json stayed
`pending` and active-waiter.owner was never removed. With the same
storm, a fork-free `while IFS= read -r` record reader and a pipeline producer
whose tri-state is returned through the reader's exit status returned correct
values on all iterations across 766,443 delivered TERMs.

Causal fail/pass: the new permanent
FleetFailureCleanup.test_repeated_waiter_cancellation_keeps_exact_cleanup runs
the unchanged cancel case while delivering TERM to the published waiter every
0.5 ms. Buggy source: 3/6 runs failed with the unexpected EOF signature (an
earlier scratch storm failed 4/10, three with the exact CI assertion
`0 != 1 : failed proof abandoned exact cleanup obligation`). Fixed source: 5/5
consecutive passes together with the original test, a 20-run scratch storm of
about 3,000 TERMs each passed 20/20, and the full fleet-stability-cleanup suite
passes. The unchanged original test also passed 96/96 under 6-core CPU load
on the buggy source, which is why the dense storm is the discriminating repro.

## Solution

### Original investigation — October 16, 2026 (superseded below)

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

### Implemented recurrence fix — November 7, 2026

Replace the command-substitution string comparison in recover_proof_slice with
`! cloudbench_process_group_state "$slice_pid" | grep -qx absent`.
The canonical tri-state producer remains authoritative and pipefail remains
active: only a successful `absent` observation authorizes recovery. This moves
parsing of the probe out of the cancellation waiter's parser context without
changing traps, child signal dispositions, cleanup counts, ownership checks,
or deadlines. It removes a failure surface instead of adding retries or
recovery state.

The independent ordinary candidate suite passed all 33 tests (32.597 seconds),
and the parent reran the unchanged complete suite on the applied source:
`python3 scripts/tests/fleet-stability-cleanup.test.py`, all 33 PASS in
32.316 seconds. Negative controls preserve failed_retained for live, unknown,
empty observations and a producer that emits absent but exits nonzero; only
absent with exit zero recovers. Golden reference: not applicable (ordinary
operational cleanup code, no approval-gated hunk).

### Implemented second-recurrence fix — November 12, 2026

Make every expansion in the signal-reachable waiter process substitution-free,
keeping traps, deadlines, ownership checks and fail-closed tri-states:
cloudbench_tracked_owner_value_into (fork-free first-match record read),
cloudbench_tristate_into (producer runs as a pipeline child; live/absent pass
through, anything else is unknown), used for every group-state probe and for
cloudbench_pid_matches_start/cloudbench_process_group_exists; arithmetic
status-grace loops; and a builtin read of the terminal status. The proof now
publishes active-waiter.owner after the log-relay process substitution, just
before the waiter; earlier cancellation is still caught by the existing
cancel.request check before launch and by repeated forwarding afterwards.
The trapped top-level controller's forward_proof_cancellation, which runs every
0.1 seconds, reads cancel.request and active-waiter.owner with builtins for
the same reason.
The quarantine marker on the original test was removed.

## Human feedback

None recorded.

## Reusable lesson

Any Bash process that can receive a trapped signal must not execute $(...) or <(...) itself; read records fork-free and return producer state from pipeline children.
