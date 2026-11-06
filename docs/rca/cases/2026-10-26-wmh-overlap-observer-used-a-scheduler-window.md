---
id: 2026-10-26-wmh-overlap-observer-used-a-scheduler-window
date: 2026-10-26
title: WMH overlap gate mistook scheduler arrival skew for serialized LLM calls
surface: harness
component: agents/benchmarks/wmh_rose_provider_test.py
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: test_rose_wmh_provider_allows_overlapping_llm_calls completed its fake calls after a 50ms sleep rather than synchronizing the observed overlap
symptoms:
  - test_rose_wmh_provider_allows_overlapping_llm_calls
  - assert client.peak_active == 2
  - assert 1 == 2
  - native_rose_provider_regressions failed while the isolated test passed
tags:
  - wmh
  - concurrency
  - fixture-race
  - scheduler
sources:
  - task /deploy agents-coverage-blackbox run 20261026-174227-3623010
  - commit b3679ea7be34ce096cc3686b6cb3d03eb746f299 (buggy overlap test)
repro: agents/benchmarks/wmh_rose_provider_test.py overlap positive and serialized negative control, invoked by agents/tests/blackbox/world_model_harness.blackbox.py
status: fixed
---

## Problem

The required agents coverage gate for the planner-context RCA failed its WMH
blackbox: nested pytest reported one failure and381 passes in36.19s. The fake
client observed peak_active1 rather than2. An unchanged isolated invocation of
the same test passed0.73s. This discrepancy is evidence about the observer;
it does not prove production serializes calls.

## Diagnosis

Path: full agents coverage -> world-model-harness blackbox -> native WMH pytest
suite -> two ThreadPoolExecutor callers -> Rose sync-to-async bridge -> fake
client's50ms observation window -> peak_active assertion.

A controlled local pytest plugin delays the second fake-client arrival150ms,
while independently measuring bridge entry/exit. The unchanged original test
fails1.03s with peak_active1 even though both bridge calls overlap (bridge peak2).
The same command/plugin passes0.92s after changing the observer. The plugin,
commands and before/after logs are retained in
`.context/rca-6731984c/investigator/wmh-findings.txt` and adjacent files.
The original loaded gate did not record arrival clocks, so its precise
historical interleaving remains unknown. The controlled experiment proves
that the test conflates legal arrival skew with bridge serialization.

Deepest owned problem: an overlap assertion relies on a short scheduler window
rather than controlling lifetime at the measured boundary. Changing provider
locks or broadening a production timeout would fix the wrong layer.

Archive searches after evidence:
- `test_rose_wmh_provider_allows_overlapping_llm_calls peak_active`
- `WMH concurrency scheduler overlap flaky sleep`
The recording-concurrency observer case and
`2026-08-03-missing-terminal-fixture-relied-on-scheduler-window` are relatives:
other observer boundaries have the same synchronization lesson. This is not a
recurrence of the production WMH shared-loop/head-of-line defects.

## Solution

Replace the fake client's50ms sleep with an asyncio.Event rendezvous, released
when both calls are active. Bound it with the existing5s caller budget. Preserve
the two threads, original peak_active==2 assertion, and both output assertions.
A new permanent negative control intentionally serializes bridge entry and
requires rejection, so this cannot turn genuine serialization green.

The controlled original command passes unchanged after this repair; five
consecutive positive/negative invocations pass. The whole owning WMH domain
passes65.3s with383 nested pytest cases. The parent subsequently observes all121
instrumented agent blackbox domains passing, plus210 cache and172 unit tests,
at84% coverage. No benchmark task or production timeout changed. At10k agents
this test-only repair adds no production state, network calls or runtime cost.

Golden references opened by the investigator: Hermes
`tests/cron/test_parallel_pool.py:212` uses a bounded threading.Barrier;
OpenClaw `packages/agent-core/src/agent-loop.test.ts:479` uses explicit start
and release promises; Codex `codex-rs/core/src/tools/parallel.rs:768` uses oneshot
notification and Notify release. The vendored Claude source had no matching
test source. The repair converges on explicit causal synchronization.
Parent reviewed the exact test-only diff and verified unchanged assertions and
full-suite receipts. This is a gate repair alongside the planner fix, not proof
of a production WMH overlap defect or of the original candidate-sourcing outcome.

## Human feedback

None recorded.

## Reusable lesson

Synchronize overlapping fake operations at the measured boundary instead of relying on a sleep-sized scheduler window.
