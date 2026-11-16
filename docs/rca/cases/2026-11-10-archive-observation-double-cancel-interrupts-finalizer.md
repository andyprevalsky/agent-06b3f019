---
id: 2026-11-10-archive-observation-double-cancel-interrupts-finalizer
date: 2026-11-10
title: Archive and observation cleanup cancelled an already retiring sibling again
surface: agents
component: benchmark-archive-observation-owner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_benchmark.py execute_agent finally cancelled a pending child already cancelling after gather cancellation
symptoms:
  - backstop returned before async finalizers joined
  - assert {'archive'} == {'archive', 'poll'}
  - test_external_cancel_joins_archive_and_poll_at_actual_backstop_boundary[running]
tags:
  - asyncio
  - cancellation
  - async-finalizer
  - benchmark
sources:
  - PR #1865
  - commit b64a017c94fbac59324191780a82fec5afcf1432
  - commit 80ed142b3db5a023f9e9530745a55103e035c13c
  - commit 5809187aba1d200d6b4cd9aa0abad65eccb5b0e2
  - commit 1c47a9131d750ab72c2a756adc5ba12aa5c3667e
repro: agents/benchmarks/wall_clock_backstop_test.py::test_external_cancel_preserves_slow_sibling_finalizer_at_backstop_boundary
status: fixed
---

## Problem

PR1865 attempt34 focused cloudbench-controller failed its registered wall-clock
suite: 1 failed, 27 passed in 5.10s. The running-phase cancellation test observed
only archive retired at the actual backstop return boundary. Native receipt:
https://github.com/Rose-Ai-Labs/rose/actions/runs/42729346683 . The original FAIL
remains authoritative; it grants no smoke prerequisite credit.

## Diagnosis

External cancellation cancels execute_agent's first gather and both child tasks.
When archive's finalizer finishes before poll's asynchronous finalizer, gather
raises CancelledError while poll is still pending with a cancellation request.
The finally loop cancelled every pending child again. That second cancellation
interrupts poll's finalizer await, so the final gather joins a completed task
whose finalizer never reached its retirement write. The five-second backstop
drain is already shielded; widening that bound cannot restore interrupted work.

Gate: NOT_INTRODUCED. The original test bytes and owning execute_agent and
_run_with_agent_execution_backstop ASTs are identical between branch b64a017 and
main80ed142. Exact original isolated running-phase tests passed once on both
local immutable snapshots; the unchanged full current28-test suite reproduced
the same missing-poll assertion in its cancel sibling. Main's unchanged suite
passed once. Those timing-sensitive results do not establish absence. A
controlled regression makes archive retire immediately and poll await its
existing0.05-second finalizer. Both running and deadline-drain phases fail with
the exact missing-poll assertion on both immutable sources. The regression
preserves original timeout and join assertions, including repeated outer cancel.

Archive searches used the exact assertion and external cancellation archive poll
double cancel finalizer. The related partial-async-state fixture case was read;
this incident is a runtime cancellation-owner defect, not that fixture ordering
cause. The original archive-concurrency implementer's actual historical task and
26-test proof were read in thread ph74hwnjjn92y5dkttwnv6v8c98hf19y before candidate
work; no active overlapping repair was found. The SDK unsealed-resource retirement
owner concerns a different boundary. This mandatory fresh controller prerequisite
repair is assigned to the deployment coordinator despite its baseline attribution.

## Solution

The integrated repair changes the finally guard to cancel a child only when it is
neither done nor already cancelling. A child not yet cancelled after a sibling
error still receives its first cancellation. Already-cancelling children finish
their async finalizers and are joined by the existing gather. Concurrent required
archival and feedback observation, original errors, cancellation propagation,
the shielded five-second drain, task budgets and evaluators are preserved.
This adds no new task or fan-out and performs constant work for the two children.

The repair adds a permanent two-phase asymmetric-finalizer regression to the
existing registered owning test module. All28original tests are byte-preserved;
the resulting30 tests passed six complete runs (initial plus five repeats).
Original causal evidence and the patch are in the private external directory
/var/tmp/deploy-mf1108/rca-controller34-wall-clock. The initial external canary
invocation omitted native conftest and failed collection for TEMPORAL_API_KEY;
that invocation is explicitly excluded from causal results. Corrected controls
load agents conftest and exercise the owning runner without provider calls.

Native verification at exact source1c47a9131d750ab72c2a756adc5ba12aa5c3667e
(digest74c2319b0768a129adb61751dfeb2fa7ec8b0462dfca47c63614741a014bda8b)
completed attempt36 controller with clean PASS at 2026-11-10T01:34:39.570251+00:00.
Workflow: https://github.com/Rose-Ai-Labs/rose/actions/runs/42733973421 .
The source-bound receipt is complete, its controller case_complete is true,
native_exit is0, and cleanup_owner is absent. The native worker result is
complete with cleanup_complete=true. All12 controller suites and the aggregate
progress row are PASS (13rows, no failures). The fetched original registered
wall-clock module log reports30passed in4.13s: all28original tests and both new
regression phases ran. Its native path is
/home/runner/_work/rose/rose/.context/cloudbench-local/run-yk8w79zy/wall-clock.log.
Local fetched evidence remains in .context/deploy-pipeline/attempts/36/focused/
cloudbench-controller/remote-artifact/files/.context/cloudbench-local/run-yk8w79zy/.
The original attempt34 FAIL/incomplete observations and historical custody are
unchanged. This assigned prerequisite was repaired and natively rerun; no waiver
or postmerge handoff was used. This verifies the cancellation repair on1c47,
not completion of the whole deployment, paid smoke or production acceptance.

Subsequent main985345c25d0e303f8f4a665451965d10de7af927 integration introduces a
sleep ratchet with this file's existing literal-sleep baseline5. The two new
regression sleeps make the unadapted merged candidate7 and fail that guard.
A separate external fixture adaptation names its0.05-second simulated slow
cleanup work and uses a zero-second next-tick yield for repeated outer cancel.
It keeps original28bytes, assertions and budgets unchanged. The same adapted
regression still fails both phases on buggyb64/main80ed and the repaired module
passes30tests locally. The actual new guard admits this module at5literal sleeps.
That pending integration needs its own combined native fresh-source validation;
the1c47 native receipt does not certify those later changed fixture bytes.
External integration proof: /var/tmp/deploy-mf1108/controller-sleep-ratchet/proof.json.

## Human feedback

The user requested completion of /deploy. No incident-specific human correction
was recorded; existing standing instructions preserve bounds and assertions.

## Reusable lesson

Do not cancel an already cancelling child again while joining its asynchronous finalizer.
