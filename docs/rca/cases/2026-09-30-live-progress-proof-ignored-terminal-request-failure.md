---
id: 2026-09-30-live-progress-proof-ignored-terminal-request-failure
date: 2026-09-30
title: Three successful LLM queries hid another terminal request failure in a fleet proof
surface: infra
component: verify-successful-llm-queries
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/verify_successful_llm_queries.py::verify derived proof success only from completed-query count
symptoms:
  - "rose.complete.failed"
  - "RoseDeadlineError"
  - "rose.complete idle for 120.0s (deadline 590.0s)"
  - "successful_llm_queries 28 despite a terminal model-request failure"
tags:
  - cloud-fleet
  - capability-proof
  - llm-progress
  - provider-stall
sources:
  - PR #1299
  - fleet run 20260930-164439-17505
repro: scripts/tests/verify-successful-llm-queries.test.py:QueryEvidenceTest.test_terminal_model_failure_invalidates_three_successes
status: mitigated
---

## Problem

Proof80's ten tasks produced trustworthy ordinary verdicts, exact cleanup, at
least three completed live responses each and ten durable evidence bundles.
The canonical count-only proof passed. Runtime inspection nevertheless found
an owned model request that failed inside the benchmark execution window. The
user's stronger no-INFRA-during-execution requirement gave the slice zero credit;
that decision is preserved separately from the original passed summary.

Whole execution/retirement wall time was 887.0 seconds; durable verification
completed after 1102.9 seconds, including an operator metadata repair. Individual
bench E2E durations were 613–624 seconds. The slice had 296 completed queries,
with median 4.08 seconds, p95 25.12 seconds and maximum 129.37 seconds.

## Diagnosis

Request afd21e4e on the a5a6aae50363 Polar task started at 16:53:27 UTC.
Cerebras rejected it for token quota after about 0.22 seconds. The configured
same-pool OpenRouter route then produced reasoning after 4.286 seconds and 255
reasoning chunks through elapsed 13.417 seconds. No further client-observed
chunk arrived for 120 seconds. At 16:55:41, the unchanged idle guard raised
RoseDeadlineError, before the 300-second benchmark cutoff. That establishes a
client-observed mid-stream no-progress failure; it does not establish whether
the provider, network, or another boundary caused the missing progress.

The primary route had 116 distinct TPM rejections: 111 requests subsequently
completed, four were still streaming when execution ended, and this one failed
its idle guard. Primary quota rejection proves the route transition, not the
cause of the later stall. The existing backend Cerebras blackbox was run with a
read-only header observer: the live key reports a 150,000-token/minute limit.
Its hash agrees with Render and the cloud backend env. No credentials were
printed or changed. A higher-quota project remains an external prerequisite
under investigation; do not claim this observer fix repairs that capacity.

The first owned wrong decision was acceptance. The verifier deliberately omitted
failed requests from successful counts, then treated any count of three as a
complete progress proof. It did not reject a different terminal request failure.
An unchanged local reproduction kept three valid completions and added the
owned, timed terminal failure. Before the fix, it incorrectly returned passed.
Archive search found related Cerebras chat/fallback cases, but their owning
boundary is runtime routing, not this count-only acceptance decision.

## Solution

Observe terminal rose.complete.failed events for the same owned agent tree and
execution window already used for completed calls. Preserve successful counts
and the task verdict; refuse proof credit when a terminal failed request is
present and report its exact request/span/type/route in failed_queries. Ignore
foreign trees and events after the execution window. A recovered primary route
rejection alone is not a terminal model-request failure.

The unchanged regression now passes, including the real verifier CLI's exit70,
failed receipt and byte-preserved task artifact. Eight tests pass, covering
ordinary valid completion, duplicates, missing artifacts, failed/foreign spans,
composite roots, owned-child failure, recovered rejections and cleanup-window exclusion. The suite
is already dispatched unconditionally by scripts/test.sh's Benchmark Successful
LLM Evidence gate; no additional deploy stage or live model calls are added.

This is an observer-only change. No prompt, model, runtime routing, cache,
evaluator, benchmark result, task budget or backstop changed. At 10,000 agents,
it examines the existing per-task evidence during acceptance; it adds no network
calls, production polling or shared hot-path coordination. Read-only adversarial review found no blocking issues in ownership, timing,
verdict preservation or recurring registration. Final-source live
acceptance and causal resolution of the upstream no-progress event remain
pending, so the case stays mitigated.

## Human feedback

Require ten consecutive mixed slices of ten distinct benchmarks, with at least
three successful live queries per benchmark and no infrastructure failures
hidden behind ordinary verdicts or runtime delays. Preserve task behavior and
benchmark failures. Inspect trajectories, concurrency and safe improvements
above five percent after each valid slice; report total and individual E2E time.

## Reusable lesson

Reject owned terminal model-request failures independently of the successful-query minimum and ordinary benchmark verdict.
