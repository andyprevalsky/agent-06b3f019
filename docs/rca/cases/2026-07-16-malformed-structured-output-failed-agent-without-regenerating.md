---
id: 2026-07-16-malformed-structured-output-failed-agent-without-regenerating
date: 2026-07-16
title: An incomplete tool call from the claudeAuth LLM failed the whole agent instead of being re-generated
surface: agents
component: llm-helpers
classification: our-bug
problem_class: model-intelligence-limitation
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
