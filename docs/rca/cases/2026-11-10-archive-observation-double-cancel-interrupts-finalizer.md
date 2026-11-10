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
repro: agents/benchmarks/wall_clock_backstop_test.py::test_external_cancel_preserves_slow_sibling_finalizer_at_backstop_boundary
status: open
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

External candidate changes the finally guard to cancel a child only when it is
neither done nor already cancelling. A child not yet cancelled after a sibling
error still receives its first cancellation. Already-cancelling children finish
their async finalizers and are joined by the existing gather. Concurrent required
archival and feedback observation, original errors, cancellation propagation,
the shielded five-second drain, task budgets and evaluators are preserved.
This adds no new task or fan-out and performs constant work for the two children.

The candidate adds a permanent two-phase asymmetric-finalizer regression to the
existing registered owning test module. All28original tests are byte-preserved;
the resulting30 tests passed six complete runs (initial plus five repeats).
Evidence and the proposed patch are in the private external directory
/var/tmp/deploy-mf1108/rca-controller34-wall-clock. The initial external canary
invocation omitted native conftest and failed collection for TEMPORAL_API_KEY;
that invocation is explicitly excluded from causal results. Corrected controls
load agents conftest and exercise the owning runner without provider calls.

Status stays open: this draft and candidate have not been integrated. After
healthy source consumers finish, the coordinator must integrate, validate the
case in the real archive, and rerun the complete source-bound native controller
gate successfully before paid smoke. Local30-test passes do not certify all
controller checks, full deploy, production or cleanup. There is no waiver or
postmerge handoff for this assigned prerequisite.

## Human feedback

The user requested completion of /deploy. No incident-specific human correction
was recorded; existing standing instructions preserve bounds and assertions.

## Reusable lesson

Do not cancel an already cancelling child again while joining its asynchronous finalizer.
