---
id: 2026-08-03-missing-terminal-fixture-relied-on-scheduler-window
date: 2026-08-03
title: Missing-terminal cloudbench fixture relied on a scheduler window for its diagnostic
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh scenario 2k — readiness was the only synchronization before a zero-budget terminal-marker assertion
symptoms:
  - 'FAIL: missing autoscaler terminal proof did not produce a stable explicit failure'
  - 'mandatory autoscaler worker capacity below desired: 0/1 workers queue-ready'
  - 'scenario 2k passes alone but fails after scenario 2j under controller-suite load'
tags:
  - cloudbench
  - autoscaler
  - fixture-race
  - scheduler
  - terminal-marker
sources:
  - commit 3bb65c59a
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenario 2k
status: fixed
---

## Problem

The full cloudbench multi-workstream gate passed the new scenario 2j regression,
then failed scenario 2k with `FAIL: missing autoscaler terminal proof did not
produce a stable explicit failure`. The controller correctly rejected the run,
but emitted `mandatory autoscaler worker capacity below desired: 0/1 workers
queue-ready` instead of scenario 2k's required `mandatory autoscaler did not
confirm terminal completion` diagnostic.

The same scenario passed when selected in isolation. The failure appeared only
in the loaded full suite, proving that production behavior was fail-closed but
the fixture's claimed diagnostic boundary depended on scheduler ordering.

## Diagnosis

Scenario 2k waits until `worker-ready.ids` is non-empty, lets the fake benchmark
child finish, and configures a zero-second autoscaler finalization budget. It
expects the parent controller to sample satisfied counts while the autoscaler is
still alive but has not published `autoscaler.completed-after-child`.

The fixture comment claimed the autoscaler was in its normal poll sleep, but it
never observed that process or established such a boundary. Under full-suite
scheduler load, the autoscaler could advance into its own post-child terminal
path before the parent sampled final state, so the parent observed a different
fail-closed condition. Readiness was therefore necessary but insufficient
synchronization for the exact diagnostic the fixture asserted. The deepest
owned cause was a contradictory harness contract: it demanded a stable causal-
marker diagnostic while leaving the process ordering to the host scheduler.

## Solution

The fleet controller now atomically publishes the exact per-bench autoscaler PID
plus immutable process start identity and persists the missing-terminal final-
acceptance reason. Scenario 2k waits for aggregated readiness, verifies that
identity, stops the exact process, proves it entered state `T`, and only then
lets the fake child finish. A detached fixture helper watches the durable
acceptance-failure marker, re-verifies identity, resumes the process, and marks
success only after that same process leaves state `T`. Its bounded safety path
cannot signal a reused PID or strand a stopped process. The test asserts stop,
acceptance, successful resume, no observer timeout, and cleanup in addition to
the original diagnostic.

No production timeout, capacity decision, or acceptance condition changed; the
new production files are lifecycle observability. At high concurrency, the
fixture's order is causal rather than scheduler-dependent, and the bounded
helper creates no global coordination.

## Human feedback

None recorded.

## Reusable lesson

When a fixture asserts an exact inter-process diagnostic, create a deterministic observation window instead of relying on the default scheduler cadence.
