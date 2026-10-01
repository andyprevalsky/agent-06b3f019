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
  - "unbound composite stage"
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
printed or changed. Higher quota could reduce frequent route fall-through;
neither its necessity for acceptance nor its causal connection to the later
idle failure has been established. This observer fix does not change capacity.

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

Proof81 on e7ad0782 exercised the stronger observer live. All ten tasks had
8–91 correlated successful queries, trustworthy FAILED verdicts and verified
retirement, but request c4a36e37 on polar-odysseys-17f506970491 failed its idle
guard after 256 client chunks. The canonical proof now rejected the slice
directly, with no retrospective waiver: zero credit, cleanup_status verified,
ten native STOPPED machines and zero pool claims. Execution and retirement took
690.7 seconds; each bench's E2E time was 606–615 seconds. The exact failing input
was recovered privately: 31 messages, six tools and unchanged 590/90/120-second
request budgets. A separate exception-accounting defect in stream.profile made
its terminal wait appear to be parsing; see the linked profiler case. Raw-wire
progress is still needed to distinguish silent transport from buffered tool
deltas. The live rejection proves the acceptance guard works; it does not prove
the underlying runtime fault is fixed.

### 2026-10-01 main integration: Foundry completion evidence

Integrating main's new Foundry route exposed an omitted completion event in the
observer's route enumeration. The actual client emits `rose.complete.foundry.done`,
but the verifier did not recognize it. Three otherwise complete, correlated live
Foundry lifecycles therefore earned zero queries. No live request was necessary:
the existing evidence suite's new owning case failed before the enum addition
and passed unchanged afterward (0.064 to 0.050 seconds for the full suite).

Add only that route event to the existing completion set. Ownership, timing,
positive usage, normal finish, duplicate/conflict checks and terminal-failure
rejection remain shared with every other route. All original eleven cases are
unchanged; the existing registered suite now has twelve cases. This does not
accept replay, partial output or a failed request, and grants no fleet credit.
Private source-bound evidence is under
`.context/acceptance/proof84-main-integration/foundry-integration/`.

### 2026-10-01 review recurrence: composite child ownership

PR #1299 review finding 4153604599 exposed inconsistent ownership validation.
The composite binding pre-pass required every observed agent ID to be the stage
root, while the subsequent common tree walk intentionally accepts that root's
connected descendants. The prior composite fixture contained roots only; the
owned-child failure fixture used a single root. Neither exercised their valid
combination. Archive searches used `unbound composite stage` and
`composite roots child live query proof`; this is a recurrence in the existing
proof owner, not an LLM/provider failure.

The added case in the existing query evidence suite supplies three completed,
correlated live lifecycles across two roots and a connected child. The real
verifier rejected it with `unbound composite stage` on unchanged 9d6 source.
Remove the conflicting root-only restriction: bind exactly one declared root,
require every observed ID to belong to that stage's tree, and retain the common
connected-tree validation. No query-count, timing, usage, completion, duplicate
or terminal-failure checks change. The same case also rejects an unknown agent,
another stage's root and a disconnected tree; an owned child terminal failure
still invalidates all three successes.

The initial formatted, identical focused command failed in 0.072 seconds and
passed after the fix in 0.063 seconds. Independent review then reproduced two
ownership gaps in that draft: another declared root could appear in a stage's
tree without an event, and a child could belong to both stages. The same added
case now includes both negative mutations, and the verifier requires disjoint
validated stage trees before issuing proof credit. This final, unchanged case
failed on the draft in 0.046 seconds and passed after the correction in 0.047
seconds. Independent review confirmed both controls and the original ownership
and terminal-failure checks. All twelve prior cases remain unchanged; the
registered thirteen-case suite passed in 0.049 seconds. Private frozen
source/test and native evidence receipts live under
`.context/acceptance/proof85-cycle2-findings/`. The active campaign source was
kept immutable in a separate checkout throughout this diagnosis. This is
acceptance-observer regression proof, not credit for any live benchmark or
resolution of the original upstream provider-stall gap.

## Human feedback

Require ten consecutive mixed slices of ten distinct benchmarks, with at least
three successful live queries per benchmark and no infrastructure failures
hidden behind ordinary verdicts or runtime delays. Preserve task behavior and
benchmark failures. Inspect trajectories, concurrency and safe improvements
above five percent after each valid slice; report total and individual E2E time.

## Reusable lesson

Reject owned terminal model-request failures independently of the successful-query minimum and ordinary benchmark verdict.
