---
id: 2026-09-30-benchmark-judge-wait-blocked-behind-controller-regressions
date: 2026-09-30
title: Serial controller regressions exhausted the benchmark domain before its live judges
surface: harness
component: agents-benchmark-blackbox-registration
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: benchmark run_all_tests synchronously completed all native controller groups before starting the first Blue Bottle judge
symptoms:
  - "benchmark domain exceeded its unchanged 300-second bound"
  - "first live judge transport began near the domain cutoff"
  - "unchanged prelude alone took 248.294 seconds without model calls"
tags:
  - benchmark
  - coverage
  - scheduling
  - controller
  - live-judge
sources:
  - commit 9d44d054cae4ed89eea11c6a469697a881583683
repro: agents/tests/blackbox/benchmark.blackbox.py::run_all_tests
status: fixed
---

## Problem

The canonical agents coverage lane failed the benchmark domain at 300.02 seconds;
the aggregate exited after 330.805 seconds with 100 passing and three failing
domains. The browser dependency and cooldown-control failures have separate
owners. The benchmark log reached the first Blue Bottle fixture's model transport
near its cutoff. This was not evidence of an idle or sustained-generation model
deadline. Original results, native owner identities, and logs remain private and
unchanged; the failed aggregate receives no passing coverage credit.

## Diagnosis

Two archive searches covered benchmark/controller timeout and coverage incidents,
then Blue Bottle judge, fixture scheduling, and registration incidents. The
scheduler-window incident from 2026-08-03 and the Blue Bottle payment-boundary
incident from 2026-08-29 were relevant guidance, but neither established this
registration bottleneck. The preceding trace-admission repair had passed the
benchmark domain in 268.67 seconds under the same 300-second bound.

An instrumented unchanged registration stopped at the first real judge function
before authentication or model calls. That boundary took 248.294 seconds. Its
largest native groups were terminal runtime/evidence (51.524 seconds), dependency
rebuild (34.129), Fly completion (30.073), autoscaler handoff (27.471), boot payload
(27.177), and bundled frontend prerequisites (20.608). This diagnostic earns zero
acceptance credit. Its timings establish the additive serial prelude; different
host load and the separately repaired dependency environment prevent attributing
the complete gate-time difference exclusively to this change.

## Solution

Thirteen isolated native checks used synchronous subprocess waits on the async
registration loop. Only after that chain and many further cases did the four
existing sequential Blue Bottle judges begin. The loaded prelude could consume
the entire domain budget before the required judge I/O progressed.

One scheduling boundary keeps every native check strictly sequential in a worker
thread while the same four judges run sequentially on the main event loop. Each
native function, command, assertion, registration name, and judge body is
preserved. Native outcomes are recorded after all four judges finish so capture
resets remain on the main loop and cannot erase active judge capture state.
Cancellation fences subsequent native groups, drains the active check, and
propagates the original cancellation, including repeated cancellation. No native
controller concurrency, model call, evaluator, task, model, or timeout is added.

## Permanent owning regression

The one permanent control drives actual run_all_tests registrations with bounded
barrier cases and sentinels for unrelated cases. It proves all thirteen native
and four judge invocations, serial native order, judge progress during the native
wait, original failure names/counts, rejection of an unexecuted coroutine, main
loop capture recording, and cancellation fencing/drain. It makes no model calls.

The identical final control, compiled into the actual unchanged baseline module,
failed in 2.111 seconds with "native wait finished before the judge progressed".
The candidate's actual registrations passed it in 0.067 seconds. This red result
uses the baseline registration, not a missing helper or an invented scheduler.
AST comparison preserves every native and judge body. The only other existing
test body changed is the later database-platform fixture described below.

## Review and outcome

Independent pre-implementation and implementation review found no parent-global
environment, cwd, or HTTP-mock mutation in the thirteen subprocess-only wrappers.
The complete existing instrumented benchmark domain finished in 246.097 seconds
under its unchanged 300-second bound; all four moved judge assertions passed.
The aggregate stayed failed because a later database-platform fixture manually
constructed ServiceStack after incoming main moved platform selection into
build_service_stack. That fixture had not been reached before the original
cutoff. Its same five platform/env expectations and original launch assertions
now exercise build_service_stack followed by start_services, with port/context
allocation mocked and the selected database mode asserted before launch. The
unchanged production path failed the old fixture and passed the corrected one;
no production database selection changed. Original failures remain retained.

The final canonical agents coverage lane passed in 339.465 seconds: all 103
blackbox domains passed with four workers, including the benchmark domain in
268.009 seconds under its unchanged 300-second cutoff. The subsequent fast-cache
suite passed all 162 tests in 5.53 seconds, and the unit suite passed all 102
tests in 39.20 seconds. The real combined coverage report met the original 80%
threshold. All 934 tracked agents/scripts input hashes remained unchanged; the
exact native wrapper and stage process were verified absent after completion.
The final proof retains the original failed aggregate and both causal controls.
No partial result is promoted into an aggregate pass, and none of this offline
evidence supplies fleet credit.

## Human feedback

The user required compact, robust runner tests without massive additional
verification. The repair adds one fast owning control, preserves the existing
controller commands and model calls, and leaves the 300-second domain bound
unchanged. After the actual later fixture failure, the required final combined
agents gate supplies the complete replay instead of a second standalone domain.

## Reusable lesson

Keep isolated subprocess waits from serializing unrelated required network I/O.
Preserve ownership, exact assertions, and cancellation drain when changing test
scheduling; a faster partial or simulated run cannot replace the real gate.
