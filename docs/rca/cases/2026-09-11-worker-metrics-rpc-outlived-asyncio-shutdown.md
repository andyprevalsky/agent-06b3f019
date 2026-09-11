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
  - "driver did not exit within the bounded terminal log catch-up window"
  - "tokio-rt-worker parked in pyo3_ffi HangThread"
tags:
  - worker-shutdown
  - temporal
  - native-runtime
  - cloudbench
sources:
  - PR #1299
  - fleet run 20260911-004427-83338
  - agent bef644f8-fbc5-402a-b663-359bbc787574
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

## Human feedback

Keep the normal 120-minute backstop and use five minutes temporarily for this
validation. Do not ask permission for authorized diagnosis, repair, and exact
cleanup. Ten slices must complete sequentially with zero infrastructure errors,
verified teardown, and durable browser evidence; do not count ordinary task
results as a clean slice or retry an unexplained failure.

## Reusable lesson

An awaited Python cancellation is not proof that a native callback has joined.
Own observability tasks through shutdown and let bounded native operations finish
while the interpreter is still available.
