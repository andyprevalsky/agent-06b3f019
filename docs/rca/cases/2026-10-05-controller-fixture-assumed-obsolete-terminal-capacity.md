---
id: 2026-10-05-controller-fixture-assumed-obsolete-terminal-capacity
date: 2026-10-05
title: Controller fixture confused replaceable readiness faults with terminal failure
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The synthetic primary completed before readiness faults while assertions required obsolete fatal capacity policy
symptoms:
  - a fleet must fail when an autoscaled worker never reaches queue readiness
  - outstanding desired capacity was not enforced at final acceptance
tags:
  - cloudbench
  - controller
  - fixtures
  - ownership
  - regression
sources:
  - commit 94a2e0f6fd5a55517ed4171152dda1d0624b0302
  - task canonical cloudbench-multi-workstream deployment gate
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenarios 2e and 2f
status: fixed
---

## Problem

The native controller suite reached scenario 2e after its preceding scenarios
passed, then asserted that a launched worker that had not reached queue readiness
must always fail the fleet. The tiny synthetic primary had already completed.
The current runtime correctly cancels unused future capacity after task completion
and preserves independent terminal evidence and resource cleanup requirements.

## Diagnosis

The original full controller gate failed in 353.243 seconds. The unchanged
isolated readiness case failed in 24.292 seconds: the task completed successfully,
the worker launch handler had executed, and the late worker was cancelled before
a readiness timeout. Holding the fake primary until a transient worker failure
marker was invalid: the runtime consumes a replaceable readiness failure by
capturing and reaping its worker, then retries capacity while work remains active.
That rejected private attempt manufactured a fake-primary deadline failure and
was preserved rather than accepted as a regression proof.

The unchanged blocked-clone case failed its obsolete literal capacity assertion
in 42.562 seconds. Its task still passed; the fleet independently rejected missing
causal autoscaler completion under the existing two-second terminal budget. The
pending provider operation retained a recoverable name-only ownership record.
The fleet failure was correct; the expected diagnostic was stale.

Archive searches using the two actual assertion strings found the retired-worker
terminal-capacity case, the missing-terminal scheduler-window fixture case and
the earlier inert-clone fixture omission. They narrowed the relevant lifecycle
boundaries; the actual task, supervisor and provider receipts determined which
policy this reproduction exercised.

## Solution

The readiness control now keeps genuine work active until its exact failed
worker has a token- and machine-bound terminal receipt with quiescent children,
reaped descendants and closed streams, and the provider confirms that worker is
absent. Only then may the fake provider permit a healthy retry. The primary
completes after a different worker reaches the real aggregate readiness ledger.
A separate completed-task inverse proves that unused readiness demand preserves
task PASS and exact resource retirement. Neither fixture uses a manufactured
primary timeout as its intended fault.

The blocked-clone control checks the actual mandatory causal-terminal diagnostic
and retains its existing failure, two-second finalization budget, absent provider
machines and recoverable name-only ownership assertions. Delayed-readiness and
missing-terminal scenarios remain intact.

Falling-demand metrics now wait for the actual successful worker launch handler
before requesting teardown, including both launches for concurrent readiness.
The repeated lower-target variant binds its desired-count barrier to the staged
driver's exact runtime token, excluding durable markers from the preceding run.
The owning 2g through 2k batch passed unchanged assertions in 463.851 seconds.

The corrected readiness and blocked-clone owning batch passed both readiness
variants and all existing terminal/resource assertions in 89.363 seconds.

Production cancellation, readiness recovery, evaluation and deadline values did
not change. Original failed full and focused receipts remain private and retained.

## Human feedback

Preserve real task PASS and exact resource release. Distinguish active-work
failure recovery from unused capacity after completion, and preserve independent
causal terminal proof. Batch all remaining fault-boundary audits before repeating
the complete native controller suite; do not weaken production policy or budgets.

## Reusable lesson

A fault fixture must keep work active through the boundary it claims to exercise.
Expected fleet failure follows current ownership and terminal policy, not a
historical capacity count sampled after a genuinely completed task.
