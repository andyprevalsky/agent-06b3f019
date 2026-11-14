---
id: 2026-10-28-autoscaler-capacity-receipt-unobserved-before-terminal
date: 2026-10-28
title: Passed task ended with missing desired-capacity observation and failed lifecycle
surface: infra
component: cloudbench-autoscaler
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: complete_autoscaler_after_child found no valid desired-worker-count; why the original producer receipt was unavailable remains unproven pending the normal controller export
symptoms:
  - autoscaler never observed valid desired capacity
  - mandatory autoscaler failed during the run
  - task_status PASSED with controller_exit_code 1
  - resources_released true and lifecycle_verified false
tags:
  - autoscaler
  - desired-capacity
  - lifecycle
  - pending-export
sources:
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - fleet run 20261028-021204-15048
  - agent ph7bpz2f14pct3j92t0e6nrvmx8h3nep
repro: bash scripts/tests/fleet-post-child-settle.test.sh
status: open
---

## Problem

It7 job r002-j0033, polar-bu-028 repetition 2, recorded native task PASSED,
controller exit 1, infra_failure false and lifecycle_verified false. Agent ID
4c940ea7-8b61-4803-9831-7b2bf37093bc belongs to fleet
20261028-021204-15048 on shard-00 controller 8747511b4737e8. The original row
started at 02:12:02.181635 UTC and finished at 02:23:46.090846 UTC. Its
resources_released flag is true, with released_at_epoch 1793154216 (02:23:36 UTC).
The error excerpt records the literal missing-capacity message above.

The teardown tail shows clone e784ee734a2718 destruction and volume
vol_rnz1gnl2d1721j1r waiting_for_detach through reconcile 4/6. This truncated tail
does not contain its eventual disposition. It cannot establish a false release
flag or native volume absence. Task PASS, controller failure, full lifecycle
failure and release are separate facts; none has been reclassified.

The launch owner supplied rows-0244.tgz with three checksum-verified files.
The exact r002-j0033 excerpt SHA256 is
8c09d1db5aeedc9309719e20988553ddeb4a2e196c4e4138421e25e3865b1d2c.
Full autoscaler logs and release receipts remain on the controller until its
normal export, expected no later than about 04:49 UTC. No additional live
provider or controller probes were made.

## Diagnosis

This is a bounded source trace, not a completed causal RCA. The exact failing
consumer is scripts/run-bench-fleet complete_autoscaler_after_child: it reads
desired-worker-count and fails when it is absent, empty or nonnumeric. The same
file's producer writes desired-worker-count.tmp then atomically renames it
before publishing autoscaler.ready. The provided excerpt cannot distinguish
never obtaining a first metrics observation from subsequent receipt loss.
It does not establish a proxy, scheduling, inventory, filesystem or task cause.

The outer controller separately waits for the collector and autoscaler, then
reads autoscaler.failed into AUTOSCALER_FAILURE. That correctly permits a task
PASS to coexist with controller/lifecycle failure. Accepting a task PASS does
not waive mandatory autoscaler observations.

scripts/run-bench-campaign.py released_attempt independently checks matching
physical run, workspace, owner, audit status, byte-identical run-local seal and
epoch, closed registry or verified retained successor, successful Hub publication
and task lifecycle_stage released. It sets lifecycle_verified only when those
release checks pass AND lifecycle.status is verified. run-bench-fleet only
publishes the provider epoch after teardown checks and separately preserves the
workload/controller error. The recorded combination alone is not contradictory.

Archive searches: autoscaler never observed valid desired capacity,
waiting_for_detach, resources_released and autoscaler never. The September 12
runtime/collector handoff, October 6 post-ready observation, and October 1
retired-worker cases are relatives, not proven recurrences. The exact error is
before a valid desired count, so their post-ready fixes cannot be assumed to
apply. Original inputs are required before choosing a repair.

## Solution

At the initial excerpt-only boundary, no runtime change was proposed. The existing owning five-case
fleet-post-child-settle suite passes at the frozen source, including explicit
malformed-capacity failure, pending-worker deadline, settled capacity and
preservation of the independent child exit. This proves the current guard
contract, not this incident's root cause or a before/after fix.

Pending normal export must include the exact job and fleet logs, autoscaler.log,
autoscaler-metrics-proxy.log, desired-worker-count and readiness/completion
markers, original task and batch run/report/lifecycle JSON, provenance,
teardown-ownership path and audit with provider epoch, and disposable cleanup
reconciliation. Check whether a first desired count was recorded, whether its
atomic receipt persisted, and whether final native dispositions justify the
release seal. Reproduce the resulting first bad boundary offline before any
protected change and obtain independent exact-snapshot review. Preserve all
original task grades, failure flags, clocks and mandatory acceptance checks.

## Human feedback

The parent required an isolated branch at frozen 19380, a 30-minute bound,
no live/provider probes or paid run, no source hotpatch, separate treatment of
potential autoscaler and release defects, and exact independent review before
any protected fix. The parent explicitly required original task PASS to remain
while full acceptance stays pending release verification.

## Reusable lesson

Distinguish a missing capacity observation from a task verdict and a provider release seal, and inspect the original producer receipts before changing any of those contracts.

### Normal export follow-up, 03:02 UTC

The normal shard export arrived with original bundle SHA256
483699babf752d1e39232530f119c20a125ba1398f726a513c929ac961738738.
It disproves the literal never-observed interpretation: autoscaler.log records
`mandatory autoscaler observed desired_machine_count=1` before the later failure.
The original desired-worker-count bytes are 30 0a (zero plus newline),
autoscaler.ready exists, benchmark-child.finished is 30 0a, and the autoscaler
completion marker is absent. No input files were changed.

The unchanged extracted complete_autoscaler_after_child run against copies of
those original terminal files returns zero. This is a failed attempt to
reproduce the original failure, not a green fix. Controlled collaborator faults
(cat returning 1 while the valid file remains, or grep returning 2) both produce
the identical original error and retain the same valid bytes. Therefore the
message alone cannot distinguish a read failure, validation-command failure or
an earlier state different from the final snapshot. The code discards cat's
stderr and status and does not distinguish grep execution failure from invalid
content. None of these injected faults establishes the original cause.

The original release audit resolves the partial-tail question: run/owner-bound
meta is provider-teardown-verified, provider epoch is 1793154216, fresh clone
disposition is destroyed-provider-retained and disposable-cleanup reports both
evidence gaps false. This is a terminal provider-retained deletion receipt,
not proof of native absence. The original task PASS and failed lifecycle stand;
there is no demonstrated false-release defect.

Compact original bytes and SHA256s are preserved in
.context/rca-i28/compact-evidence.json. The unchanged-state and fault-contrast
outputs are captured-finalizer.log and contrast-results.json in the same local
evidence directory. The cause remains open; no runtime fix or weakened
acceptance is authorized by this evidence. The owner was asked only whether the
existing normal export contains original controller system logs or process/read
errors; no additional live queries were requested.

### Diagnostic-only follow-up

The parent authorized a separate diagnostics-only repair, not a repair claim for
the historical lifecycle failure. The candidate retains the exact existing
validation predicate and durable failure marker. It records the read exit code,
validator exit code, printf exit code and whether readiness existed when the
same predicate fails. It emits no invalid raw value, environment or new provider
query. A failing read that nevertheless emits valid numeric output retains the
old acceptance behavior; the read exit is diagnostic, not a new gate.

The owning registered fleet-post-child-settle test adds controlled read and
validator failures, an invalid-value non-disclosure assertion, pre-ready
coverage, valid zero and partial-read compatibility. The unchanged test fails
on frozen source because the diagnostic fields are absent (2.794 seconds), and
passes against the isolated candidate (3.069 seconds). All five original
settlement controls remain. The exact two-path candidate SHA256 is
3ae35b029fb671ce8f304b455ca79ccaac16edcf917ca3123a0556d2742280b0;
it was independently reviewed GROUNDED by
ph74rex3pescaywbxyjn3njr158h3pp9. The reviewer applied it to temporary 19380,
passed the full registered shell gate, restored only the original runtime and
observed the unchanged test fail at missing read statuses. It is applied as a
diagnostic repair; the original autoscaler cause remains open.

Golden reference: codex/codex-rs/core/src/exec.rs:796-827 retains separate command
exit status and captured output before reporting errors. This diagnostic change
converges on explicit failure evidence, with no raw output capture at this
boundary. It does not establish why the original read or check failed.

Post-application validation: the full owning shell gate passes. Three adjacent
Python autoscaler checks pass. The additional readiness-reconcile-exit check
times out after five seconds on both the candidate and unchanged 19380
(baseline total 5.92 seconds); that pre-existing collateral failure is not
modified or counted as a pass. The exact reviewed two-path patch is unchanged.

The launch owner also supplied original manifest entries: exported
source/scripts/run-bench-fleet SHA256
8247a64267cfb19ca35bd7086d4e7407534cdf49d8c209b4fe17938375669900
(993019 bytes), and source/scripts/run-bench-campaign.py SHA256
44b816fab4e63265c325cc2e096330d49c4eddc1f255cd279eb0800adf80da02
(130316 bytes), both byte-identical to 19380. The normal export contains no
kernel, dmesg, syslog, journal, OOM, PID-exhaustion or managed memory-termination
record. Controller step output contains no further read/check diagnostic.
