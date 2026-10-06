---
id: 2026-10-01-retired-worker-left-impossible-terminal-capacity-wait
date: 2026-10-01
title: A retired worker left autoscaler finalization waiting for capacity it could no longer provision
surface: infra
component: cloudbench-autoscaler-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: complete_autoscaler_after_child retained unmet desired capacity after the last admitted worker was removed, although finalization cannot provision replacements
symptoms:
  - "worker did not reach queue readiness within 300s"
  - "removed worker so capacity can be retried"
  - "benchmark-child.finished exists while desired=1 and tracked=ready=0"
tags:
  - cloudbench
  - autoscaler
  - worker-retirement
  - post-child-finalization
sources:
  - PR #1299
  - fleet run 20261001-223923-18219
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_autoscaler_runtime_handoff_preserves_collection_and_capacity[pending_removed-1]
status: open
---

## Problem

An exact, unchanged one-task diagnostic completed its benchmark execution with
an evaluated FAILED outcome, which is acceptable for this infrastructure proof.
Its guest acknowledged shutdown at 22:49:52 UTC and its collector published exit
1 at 22:49:53. A previously admitted worker never became queue-ready. Its
retained bootstrap log reports an existing Git index lock; that upstream failure
is a separate investigation, not explained by this finalizer repair.

The controller reaped the worker and removed its pending and ownership entries
at approximately 22:57:55, leaving desired=1, tracked=ready=0. Autoscaler
finalization nevertheless continued waiting under its existing 5,160-second
provisioning-derived deadline. No provisioner or scaling decision remained that
could produce the missing capacity. The diagnostic earns zero acceptance credit.

## Diagnosis

The path is desired-capacity observation → worker allocation and staging →
primary runtime/collector completion → worker bootstrap failure → evidence
capture and verified retirement → terminal capacity reconciliation. Retirement
correctly retained the worker's evidence and removed its ledger entry. The
first contradictory boundary is the finalizer: it stops admitting capacity but
treats a settled, unrecoverable deficit like pending work.

Archive searches were `index.lock already exists worker`, `autoscaler child
completion capacity worker readiness`, and `worker clone boot command`. The
August 3 post-child ledger-contention case is a relative: transient lock
contention and genuine pending readiness must still be allowed to settle. The
September 12 runtime/collector handoff case is also a relative: a runtime seal
must not forge the independent collector's exit marker.

The existing owning regression runs the actual autoscaler, child supervisor and
authenticated status service with controlled provider/metrics boundaries. Its
new `pending_removed` variant admits one worker, seals the guest, removes that
worker exactly as verified retirement does, and releases the actual collector.
It requires explicit capacity failure within two seconds while the fixture's
general finalization budget remains thirty seconds. This distinguishes useful
terminal handling from simply waiting for the deadline.

The same command failed before the runtime edit with `TimeoutExpired` (4.91
seconds including fixture cleanup) and passed afterward (1.72 seconds):

```bash
cd agents
source venv/bin/activate
python -m pytest -q benchmarks/cloudbench_dependency_sync_test.py \
  -k 'autoscaler_runtime_handoff_preserves_collection_and_capacity and pending_removed'
```

The unchanged neighboring selection passed 36 cases, including real pending
readiness, pending failure, stuck capacity, both collector exit codes, missing
collector completion, identity/authentication rejection and prior failures.
Private evidence lives under `.context/acceptance/proof95-slice1-rca/`.

## Solution

Reuse the existing explicit capacity-failure branch when tracked capacity is
below desired, every tracked worker is ready, and no pending worker remains.
The existing deadline still handles pending or otherwise unsettled work. This
adds no timer, changes no timeout, creates no substitute success marker and
never treats absent workers as satisfied demand. Deleting desired-capacity
validation would hide the actual infrastructure failure; provisioning new
workers after runtime shutdown would violate lifecycle ownership. The repair
therefore unifies an impossible terminal state with the existing failure path.

The regression is already discovered through the permanent benchmark blackbox
gate's `autoscaler_runtime_handoff` selector and the recurring Linux controller
deploy gate. Independent review passed the four terminal-handoff variants and
reviewed this archive. The exact live outcome after repair remains pending;
this case remains open. It does not claim to resolve the
separate worker bootstrap failure or earlier browser-injection timeout.

The diagnostic's original task/runtime evidence was archived before exact-owner
cancellation. Only the mutable batch progress card changed during archival;
its later copy was retained separately. Native verification afterward found all
ten pool Machines stopped, the worker absent, zero owner claims, no owner
registry, and the owned controller process group drained. Recovery and evidence
publication do not turn this diagnostic into an accepted run.

## Human feedback

The user allows genuine evaluated benchmark FAILURE and requires zero INFRA
errors. Keep the same acceptance gate, avoid unnecessary resets, and add compact
owning regressions rather than a massive new verification framework. The user's
20 percent timeout headroom applies to infrastructure only; harness execution,
allocation-to-evidence and normal backstops are unchanged by this repair.

## Reusable lesson

Fail an impossible terminal capacity deficit once admitted work has settled,
while preserving pending-work, evidence and exact-owner cleanup obligations.
