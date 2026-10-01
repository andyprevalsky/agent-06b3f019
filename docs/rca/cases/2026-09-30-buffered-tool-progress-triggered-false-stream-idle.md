---
id: 2026-09-30-buffered-tool-progress-triggered-false-stream-idle
date: 2026-09-30
title: Continuous tool arguments triggered a false normalized-stream idle timeout
surface: infra
component: rose-stream-progress-guard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/client.py::_guarded waited for a complete normalized tool_call while streaming.py buffered productive tool arguments
symptoms:
  - rose.complete idle for 120.0s (deadline 590.0s)
  - continuous tool argument SSE bytes with no normalized tool_call yet
  - tool-only responses also exceeded TTFT while arguments were arriving
tags:
  - cloud-fleet
  - streaming
  - tool-arguments
  - idle-timeout
sources:
  - PR #1299
  - commit e7ad0782f4791827ef86dfe55cac3abe91c0cf13
repro: agents/tests/blackbox/rose.blackbox.py:test_client_buffered_tool_arguments_keep_real_progress_alive
status: fixed
---

## Problem

The request guard observed complete normalized chunks. OpenAI/OpenRouter,
Anthropic and Responses parsers intentionally buffer function arguments until
the tool is complete. A healthy 150-second argument stream therefore looked
like 120 seconds of silence after reasoning, or 90 seconds without first output
for a tool-only response. This prematurely cancelled productive inference.

## Diagnosis

The investigation followed fleet proof81's terminal request c4a36e37. Its
original wire bytes were not captured. Replaying the exact 31 messages, six
tools, model route and 590/90/120 budgets succeeded in 26.359 seconds. That
successful replay does **not** establish the original live stall's cause.
Proof80 and proof81 retain zero credit and the acceptance streak remains open.

The controlled reproduction uses the real RoseClient, mocked Cerebras429,
production OpenRouter transport and production SSE parser. After 255 reasoning
fragments, one argument fragment arrives every second for 150 seconds. Original
e7ad0782 source fails at 122.55 seconds although argument bytes arrived at the
same instant. A tool-only version fails TTFT90 while arguments are arriving.
The same final registered fixtures fail on the old client and pass on the fix.
Virtual time replaces only the client's wait proxy; HTTPX and parser execution
remain real, with explicit MockTransport and no provider traffic.

Archive searches for `rose.complete idle for 120.0s` and
`buffered tool arguments stream timeout` found the acceptance/profiler cases,
serial Cerebras fallback and malformed structured output recovery. Their
solutions and feedback concern different boundaries: this is a related but
distinct progress-contract defect, not a reason to alter prompts, regenerate
inputs, race models or relax deadlines.

## Solution

Recognized nonempty tool-argument fragments privately notify the guard through
a task-local ContextVar. They count as productive progress for the existing
idle window. Tool IDs/names, empty fragments, comments, usage and unrecognized
argument events cannot buy time. Anthropic requires an active tool block;
Responses requires a known function-call item. Complete normalized chunks and
assembled argument payloads remain unchanged. Fragments do not count as
completed queries or success evidence.

Each real HTTP attempt resets its progress state before connecting, so a prior
route's partial arguments cannot replace the next route's TTFT90 with idle120.
The heartbeat loop recomputes expiry from progress before declaring timeout,
capped by the original fixed whole-call deadline590. No deadline is raised.
Downstream consumer suspension remains excluded from provider-wait budgets but
included in the fixed outer budget. Pending reads are cancelled and responses
closed on timeout/cancellation, preserving same-tick chunk completion handling.

This is a runtime infrastructure correction: previously aborted productive
requests can now finish within their original budgets. It is not an observer-only
change or a demonstrated explanation for the original fleet failure.

Permanent async registrations in the deploy-owned Rose blackbox cover all three
protocols, tool-only output, 100 seconds of consumer suspension, silence after
arguments, metadata/comments/empty/orphan fragments, continuous progress hitting
outer590, fallback header stalls, concurrent-request isolation and cancellation.
Run `agents/venv/bin/python3 agents/scripts/run_blackbox_tests.py rose llm`.
Private before/after receipts are `.context/acceptance/buffered-progress-*.log`;
the actual four-test dispatcher reports 0/4 before and 4/4 after.

At 10,000 agents the change adds constant work per argument fragment and one
request-local callback; it adds no I/O, storage, locks, polling or model calls.
Existing heartbeat cadence and provider concurrency remain unchanged.

### 2026-10-01 review recurrence: parser progress disabled TTFT without idle checks

CodeRabbit finding 4151506588 found that buffered argument progress switched the
guard to its idle phase even when `idle_timeout_s=None`. With no idle budget,
that prematurely replaced TTFT with the full request deadline before any
productive normalized chunk was emitted. The final permanent test failed on
immutable `864644162` in 0.158 seconds. Its real-parser fixtures require the
unchanged virtual TTFT90 boundary for OpenAI, Anthropic and Responses streams.

The guard now tracks emitted productive output separately. Buffered arguments
still refresh a configured idle window; with idle checks disabled they cannot
remove TTFT before productive output reaches the consumer. Each new provider
attempt resets both states. A positive control retains supported unlimited idle
waiting after real output, still bounded by the original whole-call deadline.
No timeout constants, model inputs or completed-query semantics changed.

Independent review reran the exact six sealed provider checks successfully in
2.109 seconds, confirmed the frozen runtime/test hashes, and inspected the
request-owned cancellation/join behavior. The new test is registered in the
existing Rose blackbox. Private sealed RED/GREEN and independent receipts are
under `.context/acceptance/provider-timing-review/`. Searches `Cerebras success
quota headers TTFT` and `buffered tool arguments idle disabled deadline`
identified these existing related cases. Additional state is constant per
stream; no new provider calls, shared locks or verification stage are added.
This causal proof does not establish the cause of the original live fleet stall.

## Human feedback

Fix infrastructure only. Keep task definitions, prompts, models, evaluator
criteria and timeout caps intact. Require three completed live queries per
bench; inspect hidden infrastructure failures, LLM latency and cancellation.
Do not credit failed diagnostics or reinterpret incomplete output as success.

## Reusable lesson

Measure productive streaming progress at the parser boundary that receives it,
without requiring buffered tool arguments to become a complete tool first.
