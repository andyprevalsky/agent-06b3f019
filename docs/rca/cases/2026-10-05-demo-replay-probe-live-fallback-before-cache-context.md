---
id: 2026-10-05-demo-replay-probe-live-fallback-before-cache-context
date: 2026-10-05
title: Explicit read-only DEMO probe could enter LIVE before resolving cache context
surface: agents
component: rose-client-demo-probe
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseClient.complete entered its LIVE implementation when the explicit replay probe had no active cache context
symptoms:
  - an opted-in isolated replay probe invokes the real provider boundary after unresolved cache context
  - browser bypass and non-DEMO miss routes also escape a generic cache-write-disable flag
tags:
  - fast-cache
  - demo
  - isolated-benchmark
  - live-fallback
  - cli
sources:
  - PR #1299
repro: agents/tests/fast_cache/test_fast_cache.py::test_demo_cache_probe_refuses_unresolved_or_uncached_live_provider
status: fixed
---

## Problem

The user requested temporary DEMO cache replay for cold startup experiments,
without wasting task-model credits or changing results. The existing
`FAST_MODE_CACHE_DISABLE_WRITE_THROUGH` flag controls cache writes and strict
misses only after a usable DEMO context exists. It does not by itself promise
that a missing context cannot call a live provider. This was a scoped diagnostic
configuration gap, not evidence of a new paid production incident.

## Diagnosis

The actual central `RoseClient.complete` was executed with the explicit probe
and isolation flags. Only its final external provider boundary was replaced by
a controlled stream and counter. Original source called that boundary for an
unresolved context, browser bypass and non-DEMO cache miss; the no-spend
assertions failed. The identical owning command produced **3 failed, 2 passed,
132 deselected in 0.91 seconds**. The two inverse cases showed that ordinary
generic read-only use and nonisolated calls should retain existing behavior.

Archive searches for `read-only cache missing context live fallback` and `DEMO
benchmark declared evaluator judge cache` found the earlier missing Codex proxy
silent fallback and replay-capture cases. They are relatives, not proof that
their fixes caused this separate central-client boundary.

The explicit flag also needs process ownership. Primary and autoscaled task
workers require the guard, but benchmark judges use `check_progress` through
the same Rose client, and oversized declared evidence can use the existing
Codex judge. Applying task read-only policy to that separate harness would
turn a genuine judge miss into a fabricated evaluation error.

Archive review exposed the compatibility wrapper's separate LIVE boundary:
with an active non-DEMO context, `cached_complete` calls `_complete_impl`
directly. The central-client guard cannot intercept it. The actual wrapper and
real Rose client reproduced the escape with the same controlled external
boundary: **1 failed, 1 passed, 137 deselected in 0.38 seconds**. The passing
inverse retained ordinary generic read-only behavior when the probe was absent.

## Solution

Add `--demo-cache` through the supported CLI for existing DEMO tasks with
`fast_cache:on` and unchanged runtime replay admission. Do not add tags,
prompts, seed rows, model calls or evaluators. The explicit process marker plus
benchmark isolation fences the three central LIVE entry routes; generic
cache-write-disable behavior remains unchanged. The original owning command
then passed **5 passed, 132 deselected in 0.24 seconds**. Apply the same exact
opt-in/isolation predicate before the compatibility wrapper's direct LIVE entry.
Its unchanged owning command then passed **2 passed, 137 deselected in 0.23
seconds**, retaining ordinary behavior and every existing cache-hit path.

Forward the marker and read-only flag into the owned task stack and worker
wrappers. A pooled Machine receives an auxiliary transport slot that is
explicitly cleared on its next ordinary boot. Only the opted-in diagnostic
clears those flags from the separate `run_benchmark.py` harness environment;
declared judges run normally and may call providers. There are no provider
call-site exceptions, judge stubs or altered grading.

The user's later instruction to reuse the already working demo was implemented
with the existing mass task, whose history contained genuine replay hits.
The earlier static-only selection restriction was removed while preserving
genuine evaluation. The unchanged CLI selection/harness-scope cases reproduced
**3 failed, 14 deselected in 0.70
seconds**, then **3 passed, 14 deselected in 0.61 seconds**. Its fifty-copy
command retains fifty first-level children per task, up to 2,500 plus explore
fan-out; it is not fifty distinct tasks or a promise of zero judge cost.

The combined compact controls passed **29 passed, 129 deselected in 3.37
seconds**. Independent review passed twenty-two selection/handoff/boundary
controls and three existing genuine replay controls with the new probe enabled;
hits still replay without live calls or cache writes. The existing compact
deploy wrapper registers this coverage without adding a large or paid stage.
Two controls reuse existing July replay tests under the exact probe flags, one
for the central client and one for the compatibility wrapper, permanently
covering valid hits as well as the no-spend and ordinary-behavior inverses.
Final independent review reran that exact full scope: **29 passed, 129
deselected in 3.00 seconds**, and approved the compatibility fence and archive.
Private receipts remain under `.context/acceptance/` in
`demo-cache-probe-provider-{red,green}.private.log`,
`demo-cache-existing-workload-{red,green,controls}.private.log`, and
`cloudbench-demo-cache-{hit,mass}-independent.private.log`; compatibility-wrapper
receipts are `demo-cache-compatibility-wrapper-{red,green,controls}.private.log`.
The final combined result is in `demo-cache-final-controls.private.log`.
Final review is in `cloudbench-demo-cache-wrapper-complete-independent.private.log`.
These private logs are not committed.
These results establish the owning mechanism. Native cold-build timing and
the new cached fleet's complete lifecycle remain separate runtime evidence,
and every cached diagnostic earns zero LIVE acceptance credit.

At ten thousand agents the central guard is a constant-time branch only for
the explicit isolated diagnostic. It adds no provider probes, polling, global
locks or model calls. Ordinary runtime behavior remains unchanged.

## Human feedback

The user requested the existing working DEMO cache, small deploy regressions,
unchanged results, truthful stage timing and autonomous, deployable checkpoints.
They explicitly prohibited reward hacking and a massive verification system.

## Reusable lesson

Scope temporary replay policy to the task processes that own it. Refuse LIVE
fallback before context resolution, preserve valid hits and ordinary behavior,
and leave genuine benchmark evaluation on its existing path.
