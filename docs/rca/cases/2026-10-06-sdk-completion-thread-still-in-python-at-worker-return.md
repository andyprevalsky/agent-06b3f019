---
id: 2026-10-06-sdk-completion-thread-still-in-python-at-worker-return
date: 2026-10-06
title: Worker returned while a Temporal SDK completion thread was still running Python
surface: agents
component: worker-shutdown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/worker.py main returned after joining its metrics poller while the SDK completion thread was still inside call_soon_threadsafe
symptoms:
  - "Fatal Python error: PyGILState_Release: thread state"
  - Worker startup/shutdown failed before process-exit assertion
  - Worker entry point returned while an SDK completion thread was still running Python
tags:
  - worker-shutdown
  - temporal
  - native-runtime
  - deploy-gate
sources:
  - PR #1416
  - commit 9e4d4c340 (Step 4g agents coverage failure, 2026-10-06 05:21 UTC)
repro: agents/tests/blackbox/worker.blackbox.py
status: fixed
---

## Problem

`/deploy` Step 4g agents coverage failed in the `worker` domain. The native
metrics shutdown regression reported `Worker startup/shutdown failed before
process-exit assertion`. The same test had passed in two earlier coverage runs
that day. It hides child output, so a private copy saved it on failure. With
six CPU-bound processes saturating the four-CPU host, 2 of 36 cases failed,
both `deadline`. Each child logged `Worker stopped` and printed that its entry
point returned, then aborted with return code -6: `Fatal Python error:
PyGILState_Release: thread state ... must be current when releasing` while the
runtime was finalizing, on a thread with no Python frame.

## Diagnosis

This is the same boundary as
`2026-09-11-worker-metrics-rpc-outlived-asyncio-shutdown`, reached through a
narrower window. The earlier fix joins the metrics poller, so no RPC is
pending. The Temporal bridge, however, delivers each RPC result from a tokio
thread. That thread attaches to Python and calls `loop.call_soon_threadsafe`.
Its `_write_to_self` socket send releases the GIL. The loop can then wake,
consume the result, finish `worker.main` and start interpreter finalization
before the tokio thread re-attaches to Python and releases its thread state.

In one instrumented load run, a thread outside `threading.enumerate()` was
still at `call_soon_threadsafe` → `_write_to_self` when `worker.main` returned.
To make the window deterministic, the regression child sleeps 0.5 seconds in a
non-main thread right after the self-pipe write. That simulates the descheduled
completion thread. With the injection, all six unchanged cases returned with a
native thread still running Python. The process still exited 0, because the
sleeping thread woke only after process exit. So the owning assertion is the
return boundary, not the fatal-error interleaving.

## Solution

After the metrics poller and lag monitor are joined, `worker.main` waits up to
five seconds for threads not started by `threading` to stop running Python. It
polls every 10 ms with `asyncio.sleep`, which yields the GIL so the completion
thread can finish. If the bound expires, it logs a warning with the thread
count and returns; it never fabricates success. The owning regression keeps
its six real-SDK cases, now with the descheduled-completion injection. It also
asserts that no native thread is running Python when `worker.main` returns.
Before the fix, all six failed on that assertion; after it, all six passed. Six
repeated runs under six CPU-saturating processes passed 36 of 36. The
registered `worker` blackbox domain passed 29 of 29.

This scans per-worker thread state once per 10 ms, and only during that
worker's shutdown. It adds no RPC, shared state or work that scales with agent
count.

## Human feedback

None recorded.

## Reusable lesson

A resolved Python future does not mean the native thread that resolved it has
left Python. Wait for that thread to detach before interpreter finalization.
