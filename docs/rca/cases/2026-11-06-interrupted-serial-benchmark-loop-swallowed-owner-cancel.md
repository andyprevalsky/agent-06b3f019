---
id: 2026-11-06-interrupted-serial-benchmark-loop-swallowed-owner-cancel
date: 2026-11-06
title: Interrupted serial benchmark loop kept admitting queued paid tasks, and the staged cycle never reached the detached controller
surface: infra
component: benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py main_async exclusive/sequential serial loops awaited run_single_task, which converts the owner's SIGINT cancellation into a returned CANCELLED row, and then admitted the next queued task while current_task().cancelling() was still set
symptoms:
  - "Received signal 15; draining owned benchmark before services..."
  - "CANCELLED — collecting logs before shutdown" followed by the next queued task acquiring "AgentCard sandbox" slot
  - cancelled staged deploy cycle left agentcard-lifecycle running queued paid AgentCard tasks for about 24 minutes
  - "detached token-owned controller survived the gate"
  - "worker KILLed the draining benchmark controller"
tags:
  - benchmark-runner
  - cancellation
  - asyncio
  - deploy-gates
  - agentcard
  - teardown
  - paid-run
  - lane-token
sources:
  - plan:/var/tmp/rose-deploy-measure-evidence/attempt1/workers/agentcard-lifecycle/deploy-worker/04079ac975ffd650d3516094bd2b58988bbc0fab1d3bf7da782e9b16462ce4c3/dc7c070ea22162b4b4bd6483ef411e5c66dc8607a38ee5cc6c046a9e05711e59.log
  - plan:/var/tmp/rose-deploy-measure-evidence/attempt1/summary.txt
  - plan:/var/tmp/rose-deploy-measure-evidence/attempt1/workers/agentcard-lifecycle/local-benchmark-owner.json
repro: agents/tests/unit/test_benchmark_runner_child_cleanup.py test_interrupt_of_exclusive_serial_task_admits_no_queued_task and test_interrupt_of_sequential_task_admits_no_queued_task; scripts/tests/deploy-test-cycle.test.py GateBenchmarkControllerTeardown; scripts/tests/deploy-test-worker.test.py WorkerBenchmarkControllerKill
status: fixed
---

## Problem

The 2026-11-05 measured deploy (attempt 1, source 4e95f4d3bb2b) was interrupted
at 11:58Z. The `agentcard-lifecycle` gate (`bash scripts/run-bench --local
agent-payment-test-shop agent-payment-setup-resume
agent-payment-idempotent-abandonment agent-payment-abandonment --bootstrap
--max-concurrency 1 --no-dashboard`) reported `exit=-9 wall=333.4`, but its
benchmark kept running. The worker log shows `Received signal 15` at 203 s, then
`agent-payment-setup-resume: CANCELLED`. Immediately afterwards
`agent-payment-test-shop` acquired the AgentCard sandbox slot, followed by
`agent-payment-idempotent-abandonment` and `agent-payment-abandonment`. A second
`Received signal 15` (line 3309) changed nothing. The run finished at 1396 s
(`RESULTS: 2/4 passed`, paid tokens 432k). The owner record reached
`cleanup_verified` only at 12:47Z.

## Diagnosis

1. `benchmarks/local.py` handled the TERM by sending its runner a single SIGINT.
   `asyncio.run` cancelled the coordinator task. The cancellation landed inside
   `run_single_task`, whose `except asyncio.CancelledError` collects evidence and
   returns a CANCELLED `TaskResult` without re-raising. The serial
   exclusive-task loop (and the non-parallel loop) awaits that call directly, so
   it saw an ordinary result and admitted the next queued task. The only trace of
   the request was `current_task().cancelling() == 1`. The parallel phase was not
   affected: its `asyncio.wait` raises and its handler cancels the pending tasks.
   The coordinator regression, run with the new check disabled (the pre-fix
   behaviour), admitted all four tasks in the evidence order.
2. The staged cycle's `_execute` ran that gate as a native producer: it TERMed the
   worker's process group and SIGKILLed it after 10 s. local.py leads the worker's
   case group (run-bench execs it) and its runner and stack run in sessions of their
   own. Nothing waited for them, and no teardown receipt was written. The worker's own
   10-second case-group KILL raced the cycle's. Had it won, it would have SIGKILLed
   local.py before its cleanup traps ran. The legacy lane pipeline already had the
   token-bound `teardown_lane` for exactly this chain (2026-10-30 #1640); the staged
   cycle never called it. The new fixtures fail on the parent revision with "detached
   token-owned controller survived the gate" (native producer and owned-gate timeout)
   and "worker KILLed the draining benchmark controller".
3. The earlier partial fixtures flaked for test-only reasons: a 1.5 s wall-clock gate
   deadline could expire before the stand-in controller registered, markers were written
   non-atomically (torn read reproduced 1 of 8 under CPU load), the worker fixture's drain
   margin was 1.5 s, and a hard-coded `CONDUCTOR_PORT=15000` sat inside the deploy claim
   range.

## Solution

- `run_benchmark._refuse_queued_after_interrupt` runs after every serial
  result. When the coordinator task is `cancelling()`, it records each queued
  occurrence as CANCELLED with the coordinator's `not_started` nonadmission
  proof (the same shape the parallel path already produces). It then raises
  `CancelledError` so the normal finalize/save/cleanup path runs.
- The staged cycle stamps each gate with `DEPLOY_PIPELINE_LANE_TOKEN`. After a
  cancelled, timed-out or lingering gate (or a worker row reporting one), it runs the existing token-bound
  `run_deploy_pipeline.teardown_lane` over `<worker root>/.context/benchmarks`
  (with `reconcile_runs=False`, so the interrupted-worker recovery protocol keeps
  its run directories). It records the teardown receipt in the gate receipt.
  Only token-owned owners are signalled (controller first, then its published
  shutdown budget, then the last-resort KILL), and foreign runs are only
  reported. A KILLed or surviving owner marks the gate lingering.
- `deploy_test_process.run_command(retain_owned=...)`: the worker skips its
  10-second case-group KILL while a token-owned benchmark owner under its root is
  still draining. An unreadable inventory keeps the existing KILL.
- The fixtures are deterministic: the owned-gate deadline elapses only after
  registration (an injected deploy_test_process clock; the supervisor then hits its cleanup
  bound and orphans the controller), the native-producer gate is cancelled after the
  controller registered, markers are published atomically, the worker controller drain is
  release-file controlled, the port comes from `interrupted_root_port()`, and tearDown
  signals a pid only after an identity check. Gate names are generic: the AgentCard
  lifecycle gate was retired on 2026-11-06 (its tasks run in cloud smoke), so no gate in
  the staged cycle starts a local benchmark controller today; the cycle and worker hunks
  are the generic defence for any gate that does. The runner fix is live for every
  interrupted `run-bench --local`.

10k-agent behaviour: one `cancelling()` check per serial result, and one
`/proc` scan only after an abnormal gate. No per-agent or hot-path cost.

## Human feedback

The user approved relaunching the stopped repair, keeping the existing
kill-after budget and exact-owner rules (signal only token-owned processes,
report foreign ones), and using `interrupted_root_port()` instead of the
hard-coded 15000.

## Reusable lesson

A loop that awaits a callee which converts cancellation into a returned value must check `current_task().cancelling()` before admitting more work, and a supervisor that kills a process group must still reach that group's token-owned detached controllers through their own cleanup budget.
