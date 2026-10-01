---
id: 2026-09-30-durable-publisher-timeout-without-phase-evidence
date: 2026-09-30
title: A durable publisher exceeded its private subprocess deadline without retaining phase evidence
surface: harness
component: cloudbench-durable-publication
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: The private per-root publisher discarded TimeoutExpired output; the original slow phase remains unlocalized
symptoms:
  - "TimeoutExpired"
  - "durable_failed published_ok 9 published_agents 10"
  - "durable_verified_epoch null"
tags:
  - durable-evidence
  - publication
  - subprocess-timeout
  - phase-observability
sources:
  - PR #1299
repro: none-recorded
status: open
---

## Problem

The first ten-task cloud slice completed execution, correlated query verification
and resource cleanup, but durable publication succeeded for only nine roots.
The private orchestration helper stopped the remaining canonical publisher after
180 seconds and recorded `TimeoutExpired`. The campaign rejected all ten tasks,
paused, and retained a zero streak. Execution results do not satisfy durable
acceptance by themselves.

## Diagnosis

The failed invocation used source d09d13db, the exact sealed task run and its
retained LLM dump. The artifact directory had not been created when publication
ended. That places the failure before dump rendering, but does not identify the
original phase: startup/input validation, Hub upload and session mirroring all
precede that directory. The private helper used captured subprocess output but
discarded `TimeoutExpired.stdout` and `TimeoutExpired.stderr`. Its own log was
empty. No original phase or HTTP timing trace was retained.

The canonical Hub upload prepared a 9,931,462-byte request. Its calculated
per-attempt timeout was 48.942760 seconds; four allowed attempts and the existing
backoffs permit approximately 202.771 seconds in that phase alone. This exceeds
the private whole-command 180-second limit and is a concrete budget mismatch to
investigate. It does not establish that retries occurred in the original call
or caused this timeout. The original inherited process environment was also
not captured. Do not attribute the occurrence to transport, hosting load or a
particular endpoint without that missing evidence.

Native process and session inspection confirmed the original proof, finalizer
and publisher owners had exited before recovery. Original reports, source,
inputs and private helper were preserved with hashes. Archive searches for
publication timeouts and evidence-trace failures supplied related boundaries,
not evidence of this occurrence's cause.

## Solution

One explicitly authorized evidence-only replay ran the unchanged canonical
publisher with the same run, dump, source and 180-second outer deadline. Timing
observers preserved arguments and behavior, capturing phase boundaries and HTTP
metadata privately without bodies or credentials. The invocation returned zero
in 7.014 seconds. Its single Hub POST returned 201 in 3.979 seconds; subsequent
root and frontend reads returned 200. The required artifact manifest was
written, input/source hashes remained unchanged, and the owned process session
was empty after completion.

This establishes postmortem recoverability, not a causal fix. There is no
production change or deadline increase. The original nine-of-ten durable report
remains unchanged. The replay occurred outside the independent allocation-to-
publication cutoff, made no model calls and grants zero acceptance credit.
The original slice remains rejected.

The minimal next instrumentation belongs to the private orchestration owner:
retain each root's stdout and stderr on success and failure, including partial
`TimeoutExpired` output, and record unbuffered phase and HTTP duration/status
metadata. Preserve exact native child ownership during cancellation. A future
actual failure with that evidence must identify the owning slow phase before a
budget correction or runtime fix can be claimed. Do not add a broad suite or
weaken the permanent publication assertions for an unproven cause.

Private receipts are retained under
`.context/acceptance/proof84-publisher-timeout-review/`; the replay completion,
input binding, HTTP phase trace and original failed report are separately
hashed. No request or trajectory is committed.

## Human feedback

Complete the ten-slice goal with zero infrastructure failures; genuine task
FAILURE is acceptable. Preserve failed acceptance honestly, diagnose the
owning boundary, and use focused permanent coverage rather than massive
verification or speculative timeout increases.

## Reusable lesson

A recovered artifact does not repair historical acceptance. Preserve timeout
output and phase evidence so a whole-command deadline can be distinguished
from its unobserved latency cause.
