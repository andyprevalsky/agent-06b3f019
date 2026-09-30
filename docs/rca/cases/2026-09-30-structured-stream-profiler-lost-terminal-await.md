---
id: 2026-09-30-structured-stream-profiler-lost-terminal-await
date: 2026-09-30
title: A failed streaming await was reported as 120 seconds of parsing
surface: infra
component: structured-stream-profiler
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/helpers/llm.py::call_llm_structured_streaming updated await_s only after a successful __anext__
symptoms:
  - "stream.profile"
  - "parse_s 120.01 with await_s 10.55"
  - "rose.complete idle for 120.0s (deadline 590.0s)"
tags:
  - cloud-fleet
  - streaming
  - latency-attribution
  - exception-accounting
sources:
  - PR #1299
  - fleet run 20260930-172350-24141
repro: agents/tests/blackbox/llm.blackbox.py:test_structured_stream_profile_accounts_for_terminal_waits
status: fixed
---

## Problem

Proof81's owned explore request c4a36e37 failed its existing 120-second idle
guard. Its stream.profile reported 256 chunks, total_s 130.57, await_s 10.55,
parse_s 120.01 and callbacks_s 0.01. That report could send an infrastructure
latency investigation toward CPU parsing, despite the terminal exception having
occurred while awaiting the next normalized provider chunk. The slice received
zero credit; its ten machines stopped and its exact owner left no pool claims.

## Diagnosis

The chunk loop added elapsed await time only after __anext__ returned a chunk.
A timeout, transport exception, cancellation or delayed EOF bypassed that
addition. The finally block then calculated parse_s as total minus callbacks
minus accumulated awaits, attributing the missing terminal wait to parsing.

Archive searches for `rose.complete idle RoseDeadlineError` and
`stream 256 chunks callback stall` found related acceptance and fallback cases,
but no previous profiler-accounting case. This is a distinct diagnostic defect;
the runtime stall's cause remains open. A no-network check found no simple
256-chunk ceiling in the tested transport/parser/guard path. Raw SSE can also
contain buffered tool deltas while normalized output is silent, so these
counters alone do not establish wire silence or third-party causality.

The permanent blackbox drives the real structured-streaming entrypoint with
256 chunks and a virtual terminal wait. The final unchanged fixture dispatched
against e7ad0782's production module failed with await_s 10.24 and parse_s 120.0,
despite zero parsing time. The clock also measures callbacks independently.

## Solution

Move the existing await counter update into finally around __anext__. All exit
paths now account for their actual wait, including EOF, without adding branches,
changing streamed output, swallowing errors or adjusting any deadline.

Exact regression commands:

```bash
agents/venv/bin/python3 .context/acceptance/profile-gate-dispatch.py --baseline
agents/venv/bin/python3 .context/acceptance/profile-gate-dispatch.py
agents/venv/bin/python3 agents/scripts/run_blackbox_tests.py llm
```

The first command dispatches the checked-in blackbox through run_all_tests with
the original e7ad0782 module loaded in memory: exit 1. The second dispatches the
same fixture against the fix: exit 0. It covers deadline errors, ordinary read
errors, cancellation and delayed EOF, preserving propagation and the existing
reasoning-plus-response result. The full deploy-owned LLM blackbox discovers the
new async registration and passes all 212 checks in 43.5 seconds. Private outputs
are under .context/acceptance/stream-profile-{before-final-fixture,after}.log and
llm-profile-full-blackbox.log.

This fixes the profiler, not the original stream stall or any benchmark outcome.
The ten-slice cloud acceptance remains pending. At 10,000 concurrent agents the
change adds no polling, storage, coordination or provider requests; it moves one
existing per-await counter update to an exception-safe location.

## Human feedback

Preserve benchmark behavior and fix infrastructure only. Inspect LLM latency and
parallelism, avoid relaxing bounds to manufacture a pass, and cement regressions
in recurring tests. Report no cloud proof credit for a terminal LLM failure.

## Reusable lesson

Account for streaming wait duration on every exit before deriving CPU time from residual wall time.
