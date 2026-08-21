---
id: 2026-07-16-malformed-structured-output-failed-agent-without-regenerating
date: 2026-07-16
title: An incomplete tool call from the claudeAuth LLM failed the whole agent instead of being re-generated
surface: agents
component: llm-helpers
classification: our-bug
problem_class: other
first_bad_boundary: agents/helpers/llm.py:call_llm_structured_streaming — raised LLMStructuredOutputError on the first malformed parse with no regeneration
symptoms:
  - LLMStructuredOutputError fails the entire agent run
  - 'incomplete tool call emitted, e.g. {"tool":"think"} with no arguments'
  - EXECUTE-phase agent dies mid-run on an otherwise healthy claudeAuth call
tags:
  - structured-output
  - claude-auth
  - retry
  - execute-phase
  - agents
sources:
  - commit c5d7febd1
  - agent 628c09d7-87ce-4048-8fb6-eec3255c98fb
  - agent 06ed09a7-cacc-47dc-8631-2f4823130623
  - memory:project_cerebras_ratecap_chat_fallback
repro: agents/tests/blackbox/llm.blackbox.py
status: fixed
---

## Problem

While chasing a clean local smoke pass, EXECUTE-phase agents intermittently died
because the claudeAuth LLM emitted an incomplete tool call — e.g. `{"tool":"think"}`
with no arguments — which raised `LLMStructuredOutputError` and failed the whole
agent run.

## Diagnosis

`agents/helpers/llm.py:call_llm_structured_streaming` treated a malformed
structured-output parse as terminal: the first unparseable/incomplete tool call
raised immediately. But a truncated or partially-formed tool call from a
non-deterministic model is an expected, transient outcome — the same class of
event the existing max_tokens escalation retry already handles by regenerating.
The helper had no equivalent regeneration for parse failures, so a recoverable
single bad generation destroyed an entire multi-step agent run.

## Solution

`call_llm_structured_streaming` now **re-generates** on a malformed structured
output, up to `MAX_STRUCTURED_PARSE_RETRIES = 2` (3 attempts total),
recursive and time-guarded, mirroring the existing max_tokens escalation retry.
If retries are exhausted it still surfaces the error as non-retryable so Temporal
does not multiply the attempts on top of the in-helper retries.

Covered by tests in `agents/tests/blackbox/llm.blackbox.py` (which must register
cases via `r.record_async`).

## Human feedback

None recorded.

## Reusable lesson

Treat a malformed structured output as a regenerate-in-place condition, not a
terminal agent failure — and mark it non-retryable once exhausted so Temporal
does not multiply retries.

## Recurrence: 2026-08-03

The AgentCard lifecycle run
`75f0c6b4-2b9b-487e-9bfe-73ad533cec46` passed three tasks and failed only
`agent-payment-abandonment` (agent
`628c09d7-87ce-4048-8fb6-eec3255c98fb`). The root attempted to spawn a browser
agent without the required `start_url`. The structured-output schema correctly
required that field, but all nine Gemini 3.1 Pro generations across three
activity attempts received byte-identical messages and schema and returned the
same invalid shape. The existing bounded retry merely resampled the unchanged
request, so it could not teach the model what validation contract it had missed.

This is an owned retry-contract bug—uncorrected structured-output regeneration—
not evidence for `model-intelligence-limitation`. No controlled original-versus-
upgraded-model replay was performed, so the case is classified as `other`. The
first fix's blackbox also had a false guardrail: it accidentally exercised
Anthropic-to-OpenRouter provider fallback and asserted only the retry count, not
that the retry input changed.

`call_llm_structured_streaming` now replays the rejected turn and answers it
with the full sanitized validation error before each bounded regeneration. It
does not truncate that feedback.

The first attempt at this fix appended only a user-role correction to the
*original untouched* message list. That was still an incomplete repair: it told
the model "your previous response did not satisfy the schema" while no previous
response was present in its context, so the model had to infer its own mistake
from a Pydantic string alone. It also diverged from the three feedback paths the
codebase already had. The corrected fix follows the existing canonical shape in
`domains/spawn_browser_agent_v3/handler.py` (`_feed_browser_tool_validation_error_back`
+ `_append_browser_turn_messages`):

- A native `tool_use` turn is replayed as an assistant message carrying the
  provider's own tool-call id, answered by a paired `role: "tool"` result per
  call — a `tool_use` with no matching `tool_result` is a protocol error, and
  `providers/rose/transforms.py` requires an id + name on every assistant
  tool_call. Capturing that id required keeping `chunk.data["id"]` in
  `tool_use_blocks`, which was previously discarded.
- A text/JSON turn is replayed as an assistant message plus a user correction.

Two blackboxes pin this, one per shape:
`call_llm_structured_streaming_retries_malformed_output` (JSON path) and
`call_llm_structured_streaming_replays_invalid_native_tool_use` (native
tool_use path). Both assert the replayed turn *and* the concrete Pydantic error,
and both were watched failing against the blind-resample behavior before the fix.
Suite: 170 → 171 passing.

The unchanged `agent-payment-abandonment` retry
`87b19286-c53a-4fdf-9175-0b5376652efb` passed in 327s (agent
`06ed09a7-cacc-47dc-8631-2f4823130623`), including card abandonment, funding
reconciliation, transfer reclaim, and Stripe cleanup. Adversarial review agreed
that the diagnosis and bounded feedback fix close the owned boundary, while
requiring fresh snapshot-scoped human approval because the new feedback text is
prompt-visible.

### Secondary finding: dead blackbox tests

Adding the native-tool_use blackbox surfaced an unrelated systemic gap. Python
blackbox files are not auto-discovered — `run_blackbox_tests.py` only calls each
module's `run_all_tests()`, so a test nobody registers silently never runs while
the suite still reports green. The new test hit this immediately (suite stayed
at 170). An AST sweep found **31 pre-existing blackbox tests that are defined and
never executed**, including AgentCard retired-credential rejection, FCaptcha
payload normalization, and benchmark catalog validation.

`agents/tests/structural/structural_test_registration.py` now fails the build on
any newly-unregistered test, carries those 31 as a ratcheting `KNOWN_UNREGISTERED`
ledger that may only shrink (a stale entry also fails), and guards the same
footgun one level up — `tests/structural/*.py` is likewise hardcoded into
`scripts/test.sh` and must appear in both the serial and background invocations.
Paying down the 31-test ledger is follow-up work.
