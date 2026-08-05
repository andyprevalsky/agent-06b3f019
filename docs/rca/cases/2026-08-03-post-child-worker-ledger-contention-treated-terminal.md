---
id: 2026-08-03-post-child-worker-ledger-contention-treated-terminal
date: 2026-08-03
title: Post-child autoscaler finalization treated transient worker-ledger contention as a terminal fleet failure
surface: harness
component: cloudbench-autoscaler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet bench_autoscaler complete_autoscaler_after_child — a temporary readiness-ledger lock miss was converted to autoscaler.failed
symptoms:
  - 'mandatory autoscaler failed during the run: could not reconcile worker readiness outcomes'
  - 'FAIL: child completion must drain already-committed worker readiness'
  - 'REAL NORESULT 0/1 passed in scenario 2j autoscaler-post-child-ready'
tags:
  - cloudbench
  - autoscaler
  - worker-ledger
  - lock-contention
  - post-child-finalization
sources:
  - commit 3bb65c59a
  - commit 5641a0d078e51fd43322dfcd957444a5fead9df7
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenario 2j
status: fixed
---

## Problem

The mandatory local cloudbench controller gate failed in scenario 2j after the
benchmark child completed with one already-committed worker still crossing its
queue-readiness boundary. The controller log reported `REAL NORESULT`, followed
by `mandatory autoscaler failed during the run: could not reconcile worker
readiness outcomes` and the test emitted `FAIL: child completion must drain
already-committed worker readiness`.

That original generic reconciliation error was consistent with ledger-lock
contention but did not distinguish it from an append, marker-removal, or lock-
release error. The causal attribution below comes from the deterministic local
reproduction, not from an unrecorded original lock-timeout line.

The reduced regression acquired the real `worker-clones.ids.lock` after child
completion, published machine readiness while the lock was held, and kept the
lock until `autoscaler.log` recorded a new `timed out acquiring worker ledger
lock` line after the fixture's post-acquisition log offset.
Its durable fixture markers proved acquisition, the autoscaler's contended
attempt, readiness publication, and release were all crossed, while
`autoscaler.failed` contained `could not reconcile worker readiness outcomes`
on the buggy revision.

## Diagnosis

`complete_autoscaler_after_child` promises to drain capacity already committed
before the benchmark child exits, under
`CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS`. The surrounding live loop
could also land a child marker between its lifecycle check and readiness
reconciliation. Both paths treated every nonzero readiness result as terminal.
That operation uses the same worker-ledger lock as provisioner and cleanup
paths; exhausting its acquisition window returned nonzero, and the caller wrote
a terminal `autoscaler.failed` marker instead of handing the post-child race to
the remaining finalization budget.

The first-bad boundary was therefore the post-child caller, not readiness
publication or lock ownership: both completed correctly in the deterministic
fixture. The deepest owned cause was a contradictory harness contract—terminal
finalization was time-bounded as a whole, but one transient lock miss inside
that budget was classified as durable failure. At fleet scale, concurrent
provisioning, reconciliation, and cleanup make this contention more likely.

## Solution

`worker_ledger_lock_acquire` now returns a distinct status for lock contention.
`scripts/run-bench-fleet` retries only that status inside the existing terminal-
finalization deadline; append, marker-removal, and lock-release failures remain
immediately fatal. Each finalization poll makes one 100 ms lock attempt, sleeps
200 ms after contention, and fails closed once the terminal deadline is
exhausted instead of nesting the normal ten-second acquisition window inside
that deadline. Live-loop contention that races with a new child marker is handed
to the same bounded finalizer. Worker failure markers remain terminal as soon as
readiness-ledger access succeeds; their contents are never retried or cleared.

Deleting the worker ledger or its lock would reintroduce append-versus-rewrite
loss between provisioners and cleanup. A second timeout would create competing
sources of truth. The fix instead unifies transient reconciliation with the one
deadline that already owns all post-child settlement and adds no independent
state.

Scenario 2j now deterministically holds the real ledger lock at the post-child
boundary with one acquisition attempt configured, releasing it only after the
autoscaler's timeout diagnostic appears. The identical reduced command fails
before the controller change and passes afterward, including assertions that
the contended attempt occurred, the lock was acquired and released, and
readiness was published. At 10k-agent scale the retry remains bounded per
benchmark and adds no unbounded processes or global coordination.

## Human feedback

None recorded.

## Reusable lesson

Retry transient shared-ledger contention within the owning terminal deadline; do not convert the first lock miss into a durable fleet failure.
