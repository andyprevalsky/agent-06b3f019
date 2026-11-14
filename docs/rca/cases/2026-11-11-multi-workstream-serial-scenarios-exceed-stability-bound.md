---
id: 2026-11-11-multi-workstream-serial-scenarios-exceed-stability-bound
date: 2026-11-11
title: Multi-workstream controller suite ran ~50 independent wait-bound scenarios serially past the 1200 s stability bound
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh runs every independent scenario group back to back inside one fixture, so suite wall time is the sum of all scenario waits
symptoms:
  - cloudbench-multi-workstream.test.sh 4/5 1200s
  - run 5 cut at the 1200 s bound mid scenario 15 (controller-amb-clone)
  - CLOUDBENCH_FIXTURE_CONTROLLER START pid=
  - new-test-stability STABILITY_RUN_TIMEOUT_SECONDS=1200
tags:
  - cloudbench
  - fixture
  - stability-gate
  - timeout
sources:
  - PR #1881
  - commit e0f5b08c56
  - task new-test-stability 20261111T092429 run1..run5
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: fixed
---

## Problem

The deploy `new-test-stability` gate on PR #1881 (e0f5b08c56) runs every changed
test five times under load (8 lanes plus 8 CPU busy slots) with a hard
`STABILITY_RUN_TIMEOUT_SECONDS=1200` bound. `bash scripts/tests/cloudbench-multi-workstream.test.sh`
passed 4/5. Runs 1 to 4 took about 1170 s each. Run 5 was killed at 1200 s in
scenario 15 (`controller-amb-clone`) after about 1104 s of controller time.
Earlier rounds on the branch scored 5/5 at c90b8b4 (1153 s average), 3/5 at
2ac4b9e and 4/5 at e0f5b08. The suite sat at the bound and failed when it
crossed it.

## Diagnosis

Time decomposition from the gate's own `CLOUDBENCH_FIXTURE_CONTROLLER START/END`
lines (run 4): the controller phases span 1108 s and sum to 1034 s, running
strictly one after another. The largest are
`autoscaler-worker-oscillation-before-supervisor` (137 s),
`autoscaler-worker-required` (103 s), `bench-group-term-slowdrain` (71 s),
`autoscaler-worker-destroy-persistent` (65 s) and
`autoscaler-worker-clone-pending` (60 s). Prerequisites and fixture setup add
about 60 to 90 s.

Local reproduction on this 8-vCPU devbox with an idle host took 21:30 (1291 s)
and still exceeded the bound, using only 39% of one CPU (392 s user, 113 s
system). A sleep-logging shim on `PATH` recorded 2347 s of `sleep` calls,
summed across concurrent processes. Most came from production retry and poll
cadences that the scenarios deliberately exercise:
- worker evidence transport retries at 10, 20 and 30 s
- donor snapshot-list backoff at 15 to 18 s
- autoscaler polling every 10 s (`AUTOSCALE_POLL`)
- staging retries of 2 to 7 s

The suite is wall-clock bound, not CPU bound. Load from the gate barely changes
the total, and the 1200 s overrun reproduces without any load.

Why the margin vanished: about 50 independent controller scenarios accumulated
in one serial script, each waiting on real timing. Why this was possible: every
scenario shares one fixture root, so the only way to add coverage was to append
more serial time. Nothing kept the suite inside the gate's fixed per-run bound.
Earlier RCAs on this unit removed individual waits (prerequisite reruns, repeated
fake compilation, autoscaler idle sleep). Each removal gained back seconds while
new scenarios kept adding more, and earlier writable-clock proposals stay
rejected. This branch did not add the slow phases. Its changes to the test,
`run-bench-fleet` and `cloudbench-env.sh` shorten waits, and the slow retry
paths come from main (3942f1ef0b, e657028db6).

## Solution

The suite now runs as four independent scenario shards. A plain invocation, the
command registered everywhere, runs the parent prerequisites once. It then runs
this same script four times concurrently with `CLOUDBENCH_TEST_SHARD=1..4`. Each
shard has its own `mktemp` fixture root, fake provider, sandbox repository,
workspaces, Hubs and port-window lease, and its own final process-reaping
assertions. Each shard runs one group in the original order:
- shard 1: scenarios 1 through 2-cancel
- shard 2: scenarios 2a to 2f
- shard 3: scenarios 2g to 2k
- shard 4: scenarios 3 to 16

The parent fails unless every shard passes, and it prefixes each output line
with `[shard N]`. Focused `*_ONLY`, `*_SELF_TEST`, `*_REPRO` and
`GROUP_TERM_CASES` modes, and `CLOUDBENCH_TEST_SHARD=all`, keep the original
serial path.

No scenario, assertion, controller timeout, retry, poll interval, production
code or gate bound changed.

The first sharded run exposed one hidden order dependency. The 2-cancel runner
outlives its SIGKILLed controller group, as the scenario intends, and exits only
when its fake guest is retired. In serial order, the next scenario's
`reset_fake_state` retired that guest. Shard 1 now applies the same transition
at its boundary and waits up to 60 s for exits. The loaded run showed the runner
settling 2 to 12 s after retirement. The unchanged final orphan assertion still fails
if any controller survives.

`check_scenario_shards` in the registered
`cloudbench-fixture-process-cleanup.test.py` fails on the original file
("scenario shard list is missing") and passes on the fix. It checks that:
- every `PASS: scenario` line sits in exactly one declared shard
- all shards are used, and the final reaping check is outside every shard
- the real orchestrator block runs its shards concurrently
- a failing shard fails the suite
- focused modes stay serial, and unknown shards are refused

The prerequisite-skip check now covers numbered-shard children.

Measured: the original took 1291 s idle locally and about 1170 s on the loaded
gate. Sharded, it takes 465 s idle (PASS) and 495 s under 6 extra busy loops
(PASS). The slowest shard finishes its controllers about 372 s after the first
controller starts. The change affects only test structure and has no
10k-agent impact.

## Human feedback

The assignment prohibited weakening assertions, removing scenarios, raising
STABILITY_RUN_TIMEOUT_SECONDS or any timeout, and production behavior changes.
It allowed concurrent independent scenarios. Earlier cases record that clock
skipping and earlier metrics ticks were rejected; this fix uses neither.

## Reusable lesson

When a wall-clock-bound fixture suite nears a fixed gate bound, split its
independent scenario groups into concurrently run, privately rooted shards
rather than trimming production waits. Then check that every scenario belongs
to exactly one shard and look for state transitions that the serial order
supplied implicitly.
