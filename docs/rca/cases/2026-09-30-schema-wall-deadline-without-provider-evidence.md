---
id: 2026-09-30-schema-wall-deadline-without-provider-evidence
date: 2026-09-30
title: Schema generation reached its wall deadline while streaming; the original serving endpoint was not captured
surface: agents
component: rose-response-schema-deadline
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Upstream latency remains unlocalized; RoseClient enforced the captured 90-second whole-request deadline
symptoms:
  - "rose.complete.failed"
  - "RoseDeadlineError"
  - "call_site response_schema elapsed_s 90.004"
  - "last_chunk_s 89.912 last_chunk_kind content"
tags:
  - schema-generation
  - streaming
  - wall-deadline
  - provider-evidence
sources:
  - PR #1299
repro: none-recorded
status: open
---

## Problem

During the unchanged `agent-payment-test-shop` local benchmark, an owned schema
request failed after 90.004 seconds. The event occurred during execution and
matched that task's root directly. The exact launcher was cancelled before the
remaining task started; the interrupted gate earns zero acceptance credit.
The earlier setup and idempotent tasks had evaluated PASS in 178.5 and 303.5
seconds respectively. Their results do not erase the later infrastructure error.

## Diagnosis

The observed path is schema generation -> RoseClient.collect -> the existing
flash-pool Qwen waterfall -> normalized stream -> whole-request deadline.
The first chunk arrived after 0.345 seconds, first reasoning after 2.319 seconds,
and content continued through 89.912 seconds. The captured counters contain 263
reasoning and 62 content chunks. This was the fixed outer deadline, not a lack
of first output or an idle guard rejecting buffered tool arguments.

The helper's automatic retry used byte-identical messages, response schema and
captured configuration, with the same `qwen/qwen3.8-27b` route, and completed in
5.744 seconds. Nearby schema requests completed in 3.686 and 7.408 seconds.
Both attempts used 2 messages, max_tokens 2000, temperature 0.3,
provider_fast_mode false, deadline/TTFT 90 seconds and idle 120 seconds. Pure
reconstruction with networking disabled matched the production response-schema
builder and its effective low reasoning effort. No request body is committed.

The original dumps and retained logs lack an upstream generation ID, provider
name and raw timed SSE. The failed request has no final usage record. Those
gaps prevent distinguishing serving-endpoint latency, generation variability
and transport behavior. The successful retry is counterevidence to a
deterministic malformed-input explanation; it does not establish a cause or a
fix. In particular, the fast-mode routing flag was false, so changing its
translation would not explain this captured failure.

Archive searches `RoseDeadlineError response_schema` and `schema generation
streaming deadline progress` found the terminal-failure acceptance, buffered
tool-progress and stream-profiler cases. This is a related symptom with a
different observed timeout boundary; none establishes this occurrence's cause.
Read-only independent review confirmed these limits and the next action.

## Solution

No runtime fix is justified by the present evidence. Preserve the original
failed aggregate and privately reconstruct one unchanged local-client request
with a transport observer that records the actual outbound digest, timed SSE,
upstream identity, terminal/EOF and response closure. If that reproduces the
failure, reduce the captured stream at the owning boundary before editing code.
If it succeeds, retain this open causal gap and continue only the failed/unrun
required local tasks; never credit the failed run or diagnostic replay.

After the original stack's database and evidence were preserved and its exact
processes, database and browser sessions retired, one unchanged-client replay
completed in 4.020 seconds. The private observer verified the captured outbound
request before its only POST, blocked no follow-on request, observed a valid
schema result, closed every response and left no pending tasks. This replay's
serving provider was Parasail; its first productive output arrived at 1.198
seconds and its largest productive gap was 0.278 seconds. These observations
describe only the replay. The original provider and original credential-key
identity were not captured, so this green result leaves the cause open and
grants no acceptance credit. Continue the failed test-shop task and unrun
abandonment task on the unchanged runtime source.

No timeout, model, prompt, schema, evaluator, task definition or production
environment change is made for this investigation. There is no new runtime
coordination or verification suite. Existing permanent query-proof tests reject
an owned terminal failure even when other live responses completed.

## Human feedback

Genuine benchmark FAILURE is acceptable; infrastructure failures are not.
An owned terminal `rose.complete.failed` during execution invalidates acceptance
despite other completed queries. Preserve the original goal and complete it
autonomously, with focused permanent regression coverage rather than a large
additional verification suite. Do not expose requests or raw trajectories.

## Reusable lesson

Separate an observed whole-request deadline from its unproven latency cause,
and preserve upstream stream evidence before attributing a nondeterministic failure.
