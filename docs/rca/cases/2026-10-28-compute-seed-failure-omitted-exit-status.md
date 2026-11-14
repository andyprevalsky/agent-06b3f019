---
id: 2026-10-28-compute-seed-failure-omitted-exit-status
date: 2026-10-28
title: Compute seed failure discarded the subprocess exit status
surface: harness
component: benchmark-compute-token-preflight
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: _sync_compute_tokens tested CompletedProcess.returncode but omitted it from the failure diagnostic
symptoms:
  - Compute-token sync failed followed only by a stdout seed startup banner
  - Benchmark run could not refresh local compute tokens before agent creation
  - No seed subprocess returncode remained in captured driver logs
tags:
  - compute-token
  - preflight
  - subprocess
  - observability
sources:
  - commit 19380f9e9c1e06a8a5965c3613a512c549bd4e57
  - fleet run 20261028-021139-15597
  - task polar-bu-027 r001-j0012
repro: agents/tests/blackbox/benchmark.blackbox.py test_compute_token_sync_preserves_seed_exit_status
status: open
---

## Problem

It7 r001-j0012, polar-bu-027 run 1, reached stack readiness at 02:16:02 UTC
and the global barrier release at 02:18:05. Before any agent was created,
seed-local --compute-tokens-only returned nonzero. The runner failed at
02:18:35 with the generic compute-refresh exception. Its warning preserved
only the seed startup stdout banner. The owner retrieved the complete bounded
warning region; it contained no stderr section or subprocess exit status.
The original underlying seed failure is unresolved and remains INFRA_ERROR.

## Diagnosis

The runner already captures stdout, stderr and returncode in its owned seed
subprocess helper. The compute-sync caller uses returncode to fail closed, but
renders only the text streams. A process that exits abruptly with no stderr
therefore leaves no way to distinguish a normal nonzero exit from a signal
termination. Existing retained logs contain no OOM or signal evidence; neither
provider quota, database contention nor a timeout is established.

Offline controls run actual short child processes through the same owned
helper and present their results to the actual compute-sync caller. They cover
exit 23 with only a startup banner, termination by the child's own SIGTERM,
exit 1 with stderr, and successful exit. Before the diagnostic repair, the
known nonzero status disappears from the output. The successful and failure
return values remain unchanged.

## Solution

Include the observed numeric returncode in the existing failure warning.
Keep all credential requirements, retry owners, subprocess cleanup, timeouts,
output elision and fail-closed return behavior unchanged. Register the control
in the existing benchmark blackbox domain. This repairs lost diagnostic data;
it does not claim that the historical seed failure is fixed.

Opened primary comparison: OpenClaw process/exec.ts at immutable
76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af preserves numeric exitCode alongside
stdout and stderr on errors; its buffered result separates code and signal.
Hermes terminal_tool.py at d94b70f675205c2c046138997819428772cd2678 includes
exit_code in its error envelope. Rose's existing secrets metadata read also
preserves the native exit code. No timeout, signal translation or retry policy
is copied from these references.

## Human feedback

The parent assigned evidence-first triage while the 40-copy campaign remained
active. No live source mutation, new provider request, resource cleanup,
benchmark rerun, task edit or infrastructure reclassification is authorized
by this diagnosis. The parent and launch owner retain campaign custody.

## Reusable lesson

When a subprocess failure can be silent, retain its observed status with its
text output. Text absence is not a diagnosis. Distinguish improving future
observability from proving the cause of a past failure.
