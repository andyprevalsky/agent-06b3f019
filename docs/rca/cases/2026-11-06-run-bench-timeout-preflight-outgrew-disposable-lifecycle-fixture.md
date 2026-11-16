---
id: 2026-11-06-run-bench-timeout-preflight-outgrew-disposable-lifecycle-fixture
date: 2026-11-06
title: run-bench timeout preflight outgrew the synthetic disposable-lifecycle fixture, so its outer CLI exited 2 before any fleet ran
surface: infra
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh synthetic sandbox omitted the agents/benchmarks task-policy modules and per-task timeout_seconds that scripts/run-bench's cloudbench-timeout-policy.py preflight requires
symptoms:
  - "FAIL: disposable outer lifecycle failed:2"
  - "ModuleNotFoundError: No module named 'benchmarks.benchmark_tasks'"
  - "timeout preflight failed: autoscaler-worker-required has no valid timeout_seconds"
  - "CLOUDBENCH_TEST_DISPOSABLE_ONLY=1 bash scripts/tests/cloudbench-multi-workstream.test.sh"
  - "Cloud Benchmark Disposable Outer Lifecycle"
tags:
  - cloudbench
  - test-fixture
  - run-bench
  - timeout-policy
  - python-namespace-package
  - fixture-drift
sources:
  - commit 945d935178628213b597246359025d5c13f02d93
  - commit 8213487ac2fc97b66038cbeeb380ca8ada83db0b
  - commit e94f6c79edb7ecd2e721d75f32122ba8a767f34b
repro: CLOUDBENCH_TEST_DISPOSABLE_ONLY=1 bash scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

On the /descend integration branch `descend/epoch9-20261106` (8213487ac2) the
disposable-only mode of the cloudbench multi-workstream suite (registered in
`scripts/test.sh` as "Cloud Benchmark Disposable Outer Lifecycle") failed in
about 85 s with `FAIL: disposable outer lifecycle failed:2`. A worker had seen
this on a lean epoch9 worktree with and without its own change, while another
worker saw the default (full) mode pass on epoch6 + I-06 (e94f6c79ed); the two
results were different modes, not a regression between those revisions.

Retained fixture (`CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=1`) evidence: the only
content of `disposable-success-ws-a.log` was

```
File ".../ws-a/scripts/cloudbench-timeout-policy.py", line 15, in <module>
  from benchmarks.benchmark_tasks import get_smoke_cap, get_timeout_floor
ModuleNotFoundError: No module named 'benchmarks.benchmark_tasks'
```

so `scripts/run-bench` exited 2 at its timeout preflight (`|| exit 2`) before
any fake Machine was cloned. The identical failure reproduces at e94f6c79ed.

## Diagnosis

Critical path: test `run_controller` (disposable mode selects
`controller_entry=run-bench`) → sandbox `scripts/run-bench` → task resolution →
`cloudbench-timeout-policy.py --catalog agents/benchmarks/tasks.json` →
`run-bench-fleet`. The first bad point is the policy import in the synthetic
sandbox.

1. Commit 945d935178 (2026-10-21, "Default benchmark timeout to longest selected
   task") added the preflight to `run-bench`. The policy imports the real
   stdlib-only task-policy modules (`benchmarks.benchmark_tasks`, which pulls in
   `fixtures`, `live_fixtures`, `polar_catalog`; and `benchmarks.timeout_history`)
   and requires an integer `timeout_seconds` for every selected task.
2. The suite builds its sandbox from a hand-maintained copy list. That list never
   included those modules, and the synthetic `tasks.json` declared no
   `timeout_seconds` for the two tasks the disposable block drives through
   `run-bench` (`autoscaler-worker-required`, `bench-group-term`). The sandbox's
   `agents/benchmarks` has no `__init__.py`, so it is a namespace portion: the
   import fails unless a caller's PYTHONPATH happens to put a real checkout's
   regular `benchmarks` package on the path. Even then, the missing
   `timeout_seconds` fails the preflight (`timeout preflight failed:
autoscaler-worker-required has no valid timeout_seconds`, exit 2), verified in
   an isolated mini-sandbox with the modules present.
3. Why it survived 16 days: the default mode used by the /deploy Linux controller
   gate (Step 4cb, `run-cloudbench-controller-gate`) drives `run-bench-fleet`
   directly and never enters `run-bench`; the disposable mode is only invoked by
   `scripts/test.sh`, which /deploy does not run. The supported outer CLI path
   therefore had no deploy-run end-to-end coverage. The next rung (deploy gate
   inventory) is a deploy-instruction change that needs approval and is reported
   separately rather than made here.

Gate: NOT_INTRODUCED for the epoch7–epoch9 merges (I-07, H-18, I-08, H-21,
H-25, H-20, H-24): the failure is byte-identical at e94f6c79ed, and the only
cloudbench files those merges changed are the orphan-drain/relay-retire guests.

## Solution

`scripts/tests/cloudbench-multi-workstream.test.sh` now copies the policy's
stdlib-only import closure (`benchmark_tasks`, `fixtures`, `live_fixtures`,
`polar_catalog`, `timeout_history`) into the synthetic sandbox, and the two
tasks driven through `run-bench` declare `timeout_seconds: 240` like production
catalog rows. 240 s is below the default fleet budget, so `run-bench-fleet`'s
execution window and the default mode's assertions are unchanged. No production
code changed.

Red: `CLOUDBENCH_TEST_DISPOSABLE_ONLY=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`
on 8213487ac2 and on e94f6c79ed → `FAIL: disposable outer lifecycle failed:2`,
exit 1 (~85 s). Green: the same command on the fix → all three disposable checks
pass (two revisions create/run/destroy primary+worker; worker startup failure
retains failed outcome; outer-CLI cancellation disposes exact Machines and
Volumes), exit 0 (~190 s).

## Human feedback

None recorded.

## Reusable lesson

When a supported CLI wrapper gains a new preflight import or catalog field, update every synthetic fixture that drives that wrapper in the same change, and make sure some deploy-run gate exercises the wrapper itself rather than only the inner tool it calls.
