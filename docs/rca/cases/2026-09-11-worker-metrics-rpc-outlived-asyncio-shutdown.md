---
id: 2026-09-11-worker-metrics-rpc-outlived-asyncio-shutdown
date: 2026-09-11
title: Unowned metrics RPC reached native interpreter shutdown after worker drain
surface: agents
component: worker-observability-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: worker.main returned without joining its metrics poller and asyncio.run cancelled an in-flight native SDK request
symptoms:
  - "Worker stopped logged while the worker process remains alive"
  - "metrics became unreadable for 6 consecutive polls"
  - "tokio-rt-worker parked in pyo3_ffi HangThread"
  - "Fatal Python error: PyGILState_Release: thread state must be current when releasing"
  - "Python runtime state: finalizing"
tags:
  - worker-shutdown
  - temporal
  - native-runtime
  - cloudbench
  - blackbox-runner
sources:
  - PR #1299
  - fleet run 20260911-004427-83338
  - agent bef644f8-fbc5-402a-b663-359bbc787574
  - PR #2086 new-test-stability gate 2026-11-15T02:11Z (001-agents-blackbox-workflow-run3.log)
repro: agents/tests/unit/test_worker_observability_shutdown.py
status: open
---

## Problem

Attempt ten stopped at its first ten-task slice. All ten tasks returned ordinary
benchmark outcomes (two passes, eight failures), but polar-bu-034's worker never
exited and the guest could not acknowledge stack cleanup. This slice counts as
zero accepted slices. Its root/browser cleanup was already positively verified;
the live Steel release returned 200 with a validated response. Stack cleanup
remained pending while worker zero logged `Worker stopped` at 07:58:35.473 UTC
and remained alive at the later 08:04 capture.

## Diagnosis

The exact process was PID 2024, birth `Fri Sep 11 07:51:28 2026`, on owned Machine
d8d0796b95d518. The guest ran Python 3.11.2 and Temporal SDK 1.32.0. A native
py-spy dump found only the main thread waiting in a parking_lot condition
variable inside temporal_sdk_bridge, and a tokio runtime thread parked in
pyo3_ffi's HangThread. This proves a native shutdown hang after worker drain.
The limited stack does not show a complete Runtime Drop chain or identify the
originating RPC. Earlier Count RPCs had returned namespace RESOURCE_EXHAUSTED;
those observations motivate the error fixture but do not prove which request
was in flight at shutdown.

`worker.main` started the metrics poller with an unretained create_task and
returned without stopping it. asyncio.run then cancelled pending tasks. The
SDK bridge can complete a cancelled Python future while its native callback is
still scheduled to attach to Python. PyO3 parks such a thread once interpreter
finalization has begun. The matching upstream sources are
[PyO3 0.29](https://raw.githubusercontent.com/PyO3/pyo3/v0.29.0/pyo3-ffi/src/pystate.rs),
[the async bridge](https://raw.githubusercontent.com/PyO3/pyo3-async-runtimes/v0.29.0/src/generic.rs),
and [SDK 1.32 client error conversion](https://raw.githubusercontent.com/temporalio/sdk-python/1.32.0/temporalio/bridge/src/client.rs).

A minimal real-SDK child with a parent-owned delayed gRPC response exited on
macOS but hung three out of three times on Linux, after asyncio.run returned.
The permanent regression runs the actual worker entry point and actual SDK
against a local gRPC server; only activity execution is replaced by an idle
worker with explicit readiness and request-entered handshakes. Before the fix,
it failed because the worker entry point returned while its native Count RPC
was unfinished. That is the owning-boundary causal proof; not every scheduling
interleaving must deadlock for that ownership violation to be a failure.

An initial fixture completed the idle worker before readiness and raised a
startup error. It was corrected before recording causal evidence. A subsequent
fixture inspected the SDK's default 30-second deadline; that assertion alone
was not treated as causal proof. The final assertion checks RPC completion
ordering and actual child exit. Adding the Describe matrix briefly exposed a
pytest parameter/default conflict, which was corrected without changing the
runtime or assertions.

Archive searches used `driver did not exit`, `metrics became unreadable`,
`shutdown hang`, `Worker stopped`, and `default executor`. The cloud archive /
worker recording case is related: its supervisor correctly waits for workers,
but cannot resolve this independent native finalization deadlock. The prior
outcome/lifecycle case correctly rejected the slice instead of accepting its
ordinary task results as teardown proof.

## Solution

Retain the metrics task through activity and browser cleanup. Then set its stop
event and await its current RPC naturally, without cancelling the Python SDK
future. Check stop after each awaited observation so no later Count, Describe,
or fleet read starts during shutdown. Wake an idle poller through the same
event. Cancel and join the pure-Python lag monitor separately.

Independent review also reproduced four peer requests, three after stop, in each
of the two sequential fleet scrapers. Pass the same stop event into their inner
loops and the provider actuation loop. A registered five-scenario blackbox now
checks memory scraping, admission scraping, machine listing, start, and stop:
each finishes only its current request and begins no later one after shutdown.

Metrics RPCs have a five-second native deadline and no hidden SDK retries; the
existing polling loop owns retries and continues reporting failures. The first
fix used high-level count_workflows with a per-attempt deadline, but persistent
RESOURCE_EXHAUSTED still retried beyond that deadline. Its regression failed;
using the explicit nonretrying service call makes the whole request bounded.
No benchmark, recording, controller catch-up, readiness, or worker-drain limit
was raised. Normal benchmark backstop remains 120 minutes; this validation uses
five minutes.

Six Linux regressions pass: delayed success, RESOURCE_EXHAUSTED, and native
deadline expiration at both Count and Describe. They assert actual process exit,
no subsequent RPC after drain, and the native deadline. The worker blackbox
registers the same six cases. The Temporal gRPC extra explicitly supplies the
fixture's server dependency. This adds no per-agent task, provider request, or
shared state: lifecycle ownership is per worker, with constant extra storage.

Private evidence is under `.context/acceptance/proof10-slice1-forensics/`, with
hashes and paths in manifest.json. Reproduction logs are
`native-runtime-repro-linux.log`, `worker-native-final-repro-before.log`, and
`worker-native-exit-six-fixed-final.log`. The live VM's exact deadlocked worker
was killed only after preserving the native stacks and verifying the token-bound
root cleanup receipt; the fleet's exact-owner recovery owns resource retirement.
This does not convert the failed slice to a pass.

The exact unchanged polar-bu-034 live task and a fresh ten-slice campaign remain
required. Until those outcome and lifecycle gates pass, this case stays open.

### 2026-10-01 review recurrence: failed metrics join skipped cleanup

CodeRabbit finding 4151506632 exposed a missing exceptional join case. The
permanent worker blackbox runs actual `worker.main` with a poller that waits for
the real stop event and then raises. It checks both a clean worker return and
an original startup error. The unchanged runtime failed in 5.83 seconds because
the profiler was never disabled or dumped. After the fix, the identical test
passed in 2.50 seconds: the poller is joined, the lag monitor is cancelled, the
profiler finishes, and the final stopped log is emitted. A metrics-only failure
still propagates after cleanup; an earlier worker failure remains primary.

The earlier native-RPC matrix proves natural completion of successful and
provider-rejected RPCs, but its poller never failed outside its internal retry
handler. That omitted branch let the finally block replace earlier errors and
skip later cleanup. The fix retains the same stop event, native deadlines and
shutdown order, with constant per-worker state and no added provider calls.
The review's separate claim about ordinary startup exceptions between task
creation and the try is not established: there is no await in that interval.
The intentional hard `os._exit` path is unchanged.

Archive searches were `Worker shutdown pending metrics poller` and
`supervisor teardown receipt cleanup signal`. Private RED/GREEN receipts are
`.context/acceptance/proof84-worker-review-{red,green}.receipt.json`. Activate
`agents/venv`, run from `agents/`, and invoke
`test_worker_metrics_failure_preserves_primary_and_finishes_cleanup` from
`tests/blackbox/worker.blackbox.py`; the test is also registered in the normal
`python scripts/run_blackbox_tests.py worker` deploy gate. The original live
benchmark outcome gap remains open.

## October 6 recurrence: a delivered completion still had a native tail

The `/deploy` agents coverage lane on a 4-core Cloud VM failed the worker
domain once: `Worker startup/shutdown failed before process-exit assertion`.
The test passed 18 of 18 cases when replayed alone. Under a 14-process CPU
burn, a copy that prints the child output reproduced it twice. Both times
`Worker stopped` and `WORKER_ENTRYPOINT_RETURNED` were already printed. One
exit was SIGSEGV after `success-count`. The other, with `faulthandler`, was
SIGABRT after `deadline-count`: `Fatal Python error: PyGILState_Release:
thread state ... must be current when releasing`, `Python runtime state:
finalizing`, from a thread with `<no Python frame>`.

The earlier fix joined the metrics task, but the native callback that
resolves the awaited RPC future can still be running. The bridge resolves it
on a Tokio thread through `call_soon_threadsafe`, and the self-pipe `send()`
releases the GIL before that Python call returns. The main thread can then
return from `worker.main()` and start finalization. When the Tokio thread
retakes the GIL, the thread is exited and pyo3's guard drop releases a
non-current thread state. A `ctypes` pthread running Python in the same
GIL-released state reproduces the cut-off: without a join its callback never
finishes, and with one it does.

Before logging `Worker stopped`, `worker.main()` now waits (at most 2 s)
until no thread outside the `threading` module, dummy threads included, has a
live Python frame. It logs a warning if the wait times out. Two unit tests
drive real native pthreads. One proves the wait covers an in-flight Python
callback, and fails if dummy threads are treated as owned. The other proves
the wait is bounded. Under the same CPU burn, 60 runs of the process test
(360 real worker exits) passed with no crash and no timeout warning; before
the fix, roughly 1 in 60 exits crashed. The cost is one thread-table scan per
worker exit, independent of agent count.

## November 15 recurrence: the blackbox runner had no native-callback join

PR #2086's `new-test-stability` deploy gate failed `agents-blackbox:workflow`.
It ran five times under 8 busy-loop workers on an 8-vCPU Blacksmith VM, and
run 3 printed `Results: 1 passed, 0 failed` and then exited -6. The stderr
showed the same `PyGILState_Release ... must be current when releasing` and
`Python runtime state: finalizing` abort, from a thread with
`<no Python frame>`. A gate rerun then exited -11 after passing. The defect is
on main (gate attribution NOT_INTRODUCED): the October fix joined native
callbacks only in `worker.main`. `scripts/run_blackbox_tests.py` also drives
the SDK, through `WorkflowEnvironment` and `Worker` shutdown, and it returned
from `asyncio.run` into `sys.exit` with no join (first bad boundary: its
`main()`).

Archive searches were `PyGILState_Release finalizing SIGABRT blackbox runner`
and `native callback interpreter shutdown tokio exit -6`. Both found this case,
which makes this a recurrence: the guardrail covered one entry point, not the
class.

Repro: a driver called the runner module's real `main()`, with the domain suite
replaced by the SDK alone (a time-skipping environment, one Worker, one
workflow). On unmodified main, 4 of 300 runs crashed under CPU load: one with
this exact SIGABRT, three with SIGSEGV. A second baseline batch of 300 ran
with `PYTHONFAULTHANDLER=1` and crashed once (SIGSEGV after the results line).
faulthandler printed no stack, which is consistent with a fault after Python's
fault handling was torn down, but it does not attribute the SIGSEGVs. In total,
5 of 600 baseline runs crashed. The original command
(`BLACKBOX_CASE_FUNCTIONS=test_workflow_check_cost_limit_skips_non_root python scripts/run_blackbox_tests.py workflow`;
the gate's own case exists only on PR #2086) ran in batches before and after
the fix under the same load. Those counts are in the fix PR, and each batch is
too small to show a 1-in-18 rate on its own.

The drain moved unchanged from `worker.py` to `helpers/process_exit.py`.
`worker.main` and the runner's `run_tests_then_join_native_callbacks` now both
await it, the runner from a `finally` before `asyncio.run` returns. With the
fix, 0 of 600 runs of the same driver crashed (300 of them with faulthandler),
and none hit the drain timeout (one-sided Fisher p ≈ 0.03 against 5 of 600).
The runner regression,
`test_runner_exit_waits_for_native_sdk_callback_still_in_python`
(`agents-pytest` lane), runs the real `main()` while a native pthread is still
in Python. It failed without the runner change and passed five consecutive
times with it at load average 22.

The runner does not use the worker's `os._exit` (`run_then_exit`): the agents
coverage gate runs `coverage run --parallel-mode scripts/run_blackbox_tests.py`,
and coverage saves its data from atexit. An independent verifier reached the
same first bad boundary. It noted one residual window. A task that is still
awaiting a bridge future when `asyncio.run` cancels leftovers could call back
after the drain. There is no evidence of such a task in the runner, so no
handler was added for it. Other SDK entry points that use plain `asyncio.run`
have not been checked: `benchmarks/run_benchmark.py`,
`benchmarks/sms_runner_test.py`, `scripts/regen_mass_agent_verifier_rows.py`,
and the `__main__` blocks of individual blackbox files. They are outside this
repair's scope and are not deploy gates.

## Human feedback

Keep the normal 120-minute backstop and use five minutes temporarily for this
validation. Do not ask permission for authorized diagnosis, repair, and exact
cleanup. Ten slices must complete sequentially with zero infrastructure errors,
verified teardown, and durable browser evidence; do not count ordinary task
results as a clean slice or retry an unexplained failure.

## Reusable lesson

An awaited Python cancellation or completion is not proof that a native callback has joined.
Every process entry point that drives the Temporal SDK, test runners included,
must join native callbacks before it leaves `asyncio.run`. Own observability tasks through shutdown and let bounded native operations finish
while the interpreter is still available.
