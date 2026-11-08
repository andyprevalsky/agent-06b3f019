---
id: 2026-11-08-readiness-retry-fixture-fixed-window-raced-autoscaler-poll
date: 2026-11-08
title: Scenario 2e's fixed 30 s readiness-retry window raced the controller's 10 s autoscale poll on a loaded host
surface: harness
component: cloudbench-multi-workstream fake driver (worker-readiness-retry fixture)
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh run_fake_driver worker-readiness-retry block — `deadline = time.time() + 30` bounded a controller path that spans the readiness timeout plus two 10 s autoscale polls when cleanup ends just after a poll
symptoms:
  - "FAIL: readiness active-retry must preserve completed task and exact worker retirement"
  - "FATAL: readiness failure never crossed captured cleanup and healthy retry"
  - "removed worker <id> so capacity can be retried"
  - retry worker joins the queue ~4 s after the fake guest's fixed 30 s deadline
tags:
  - cloudbench
  - multi-workstream
  - autoscaler
  - fixture-deadline
  - load-flake
  - descend-i-37
sources:
  - commit ecf2ae8bdc (epoch23, fail) / 72889c4389 (epoch22, fail) / d8d7a8ab1e (epoch21, pass at 00:51Z)
  - commit 379acb3361 (fix, branch rca/i-37-20261108; descend run descend-failed-neverrun-20261106 cluster I-37)
  - memory:structural-gate-load-flakes
repro: scripts/tests/cloudbench-multi-workstream.test.sh (CLOUDBENCH_TEST_READINESS_RETRY_ONLY=1 selects scenario 2e; full gate runs it in sequence)
status: fixed
---

## Problem

The mandatory Linux deploy gate `bash scripts/tests/cloudbench-multi-workstream.test.sh`
failed scenario 2e, `readiness active-retry must preserve completed task and exact
worker retirement`, on epoch23 (ecf2ae8bdc, twice) and on the epoch22 base
(72889c4389, readiness-only). Epoch21 (d8d7a8ab1e) passed the same gate twice.
The fake guest log said `FATAL: readiness failure never crossed captured cleanup and
healthy retry`. The controller behaved correctly: the never-ready worker was captured
and destroyed, a retry worker was created, and it joined the queue — about 4 s after
the fake driver's fixed 30 s deadline. Host load was ~8 on 8 cores from other agents'
test runs and a live campaign.

## Diagnosis

Code: d8d7a8ab1e..72889c4389 changes only `agents/browser_tools/dom_service.py`,
`agents/domains/spawn_browser_agent_v3/service_actions.py`, an agents blackbox test and
RCA docs (H-58). No script, fixture or controller in this scenario references them
(`grep dom_service|service_actions|browser_tools` over run-bench-fleet, run-bench-cloud,
cloudbench helpers, lib and the test: no hits). Under the same controlled condition
(transient service, `CPUQuota=100%`) d8d7a8ab1e and ecf2ae8bdc both failed identically,
so the epoch21 pass was not a property of its source.

Mechanism, from a sampler (runs under /var/tmp/rca-i37/runs; original failure logs /var/tmp/epoch23/evidence-2e) that timestamped the bench output ledgers
(`desired-worker-count` is rewritten once per autoscaler tick; `worker-clones.ids`
drops the failed worker when cleanup finishes; `worker-ready.ids` is written only by
`reconcile_worker_ready_outcomes` at a tick). ecf2ae8bdc under CPUQuota=100%:

- T0 03:57:05.86 scale up; clone 03:57:09.1; launch ~03:57:13 (fixture's 30 s starts).
- T1 03:57:21.50; the failed worker leaves tracking at 03:57:22.07, **0.56 s after T1**, so T1 sees pool=1 and does nothing.
- T2 03:57:31.70 retries; clone 03:57:34.6; `.ready` 03:57:38.1.
- T3 03:57:46.22 reconciles `worker-ready.ids` — after the fake had already FATAL'd (child finished 03:57:47.05).

d8d7a8ab1e: cleanup missed T1 by 0.88 s, same three-tick shape. Two more runs on
d8d7a8ab1e and 72889c4389, intended as uncontended but sharing the host with three full
gate runs, missed T1 by 2.3 s and 3.6 s and failed the same way. With no added load (host
load ~3-5) the same unchanged d8d7a8ab1e and 72889c4389 sources PASSED: cleanup
untracked the worker 0.25 s and 0.31 s *before* T1, so T1 retried and T2 reconciled
readiness ~25 s after launch. Pass/fail is decided by which side of one tick the cleanup
lands on. The ~16 s "retry delay"
is the controller's fixed `AUTOSCALE_POLL=10` sleep plus the synchronous clone: the
retry happens on the first tick after cleanup, and readiness is reconciled one tick
after that. Both are designed cadence (prod parity, paced for the Temporal Visibility
budget), not an unnecessary serial wait.

Arithmetic: from the launch boundary the fixture needs readiness timeout (5 s) + probe +
capture + destroy, then up to one poll for the retry, staging, and one more poll for
reconciliation. T1 − T0 (10 s + tick work) and cleanup − T0 (clone + staging + 5 s +
capture + destroy) are nearly equal even on a quiet host, so the phase is a near coin
flip; the cleanup chain has many more serial subprocess spawns than a tick, so load
pushes cleanup consistently past T1, and the path becomes ~32–33 s (> 30 s).

Step 5a ladder: (1) the fixture FATAL'd before a correct retry was reconciled; (2) its
deadline was a fixed 30 s wall clock that does not correspond to any controller or task
bound; (3) the fixture's own contract ("keep queued work active ... no fixture deadline is
the fault") already required the bound to be the task's lifetime, so the defect is the
fixture contradicting that contract. The next rung (the controller should react to
provisioner exit instead of polling) is a design decision; even an immediate retry still
waits one poll for reconciliation, so it would not remove the race.

Failed fix attempt recorded: the first patch read `time.time()` once more at benchmark
start; the "fake terminal contract" fixture drives `run_fake_driver` with a three-value
fake clock and failed `post-admission-error StopIteration`. The final patch keeps a
single clock read in the readiness block.

## Solution

`run_fake_driver`'s worker-readiness-retry wait is now bounded by the task's own staged
execution budget (`BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS` from the staged `rb.sh`; 240 s
here), which is how long genuinely queued work stays pending. A missing or non-positive
budget fails closed. The asserted boundary is unchanged: the failed worker's terminal
receipt (quiescent, children reaped, streams closed), its readiness-timeout stage log and
its exact provider absence must all be observed before a different worker appears in
`worker-ready.ids`; the task PASS, capture and teardown assertions are untouched. The
proof marker and bench.log now record the elapsed seconds.

Red→green under the same CPUQuota=100% condition: ecf2ae8bdc failed; the fix (379acb3361)
passed scenario 2e with cleanup missing T1 by 3.2 s (three-tick path, ~33 s from launch).
Three full gate runs of the fix (run in parallel, load ~8-13) passed 76/76 checks each, and
every one hit the late-cleanup phase (cleanup 0.26-0.31 s after T1, readiness reconciled
~33 s after launch), which the old 30 s window would have failed. The regression is the
existing scenario in the mandatory deploy gate; under load it now exercises the
late-cleanup phase instead of failing on it. 10k-agent behavior: test
fixture only; no runtime change.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Bound a fixture's wait for controller progress by the controller's or task's own budget, never by a fixed window shorter than the controller's poll cadence path.
