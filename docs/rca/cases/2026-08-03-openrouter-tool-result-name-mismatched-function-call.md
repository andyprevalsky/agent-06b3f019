---
id: 2026-08-03-openrouter-tool-result-name-mismatched-function-call
date: 2026-08-03
title: Stored tool-result aliases violated Gemini's function-call name contract
surface: agents
component: llm-message-construction
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py build_llm_messages copied metadata.toolName into a matched tool result instead of deriving the name from the declared assistant call ID
symptoms:
  - 'OpenRouter HTTP 400 "Provider returned error" from Google AI Studio'
  - '"Request contains an invalid argument." with status "INVALID_ARGUMENT"'
  - 'assistant function call name "spawn_agent" followed by tool-result name "spawn_browser_agent"'
tags:
  - openrouter
  - gemini
  - tool-results
  - message-construction
  - agentcard
sources:
  - PR #927
  - agent 1c01396a-6db5-4fa7-b3d8-0f6e5bb3d7bb
repro: agents/tests/blackbox/llm.blackbox.py
status: fixed
---

## Problem

The local `agent-payment-setup-resume` gate terminalized agent
`1c01396a-6db5-4fa7-b3d8-0f6e5bb3d7bb` after 267.5 seconds. Its Rose fallback
reached OpenRouter, but Google AI Studio rejected the request with HTTP 400,
`INVALID_ARGUMENT`, and `Request contains an invalid argument.` The captured
assistant message called `spawn_agent` with ID `cr7x81sa`; the matching stored
tool-result message used the implementation alias `spawn_browser_agent` for that
same ID.

The captured request was reduced one message at a time during diagnosis. The
prefix before the tool result returned HTTP 200, adding the mismatched result
returned 400, and changing only its name to `spawn_agent` returned 200. The
complete live replay command and request body were not retained as an artifact,
so the checked-in synthetic regression is the durable reproduction.

## Diagnosis

`build_llm_messages` correctly emitted the canonical assistant function name,
but tracked only the set of declared call IDs. When it later built a matching
tool result, it copied the independently stored `metadata.toolName` alias. That
was the first bad boundary: the shared message builder created an internally
inconsistent conversation before any provider-specific transform ran.

OpenRouter converts OpenAI-compatible messages to Gemini
`functionCall`/`functionResponse` parts, whose names must match. The deeper owned
cause was two sources of truth for tool identity even though the stable
`tool_call_id` already joined the call and result. Archive searches for the exact
`INVALID_ARGUMENT` payload and function-response mismatch found no recurrence;
`2026-07-21-gemini-fallback-unbounded-reasoning` is only a relative involving an
untested Gemini fallback boundary.

## Solution

`build_llm_messages` now records the canonical assistant function name by
`tool_call_id` and always derives a matched tool result's name from that map. It
also rejects a reused call ID that declares conflicting names. Provider
transforms remain pass-through for this invariant, so every downstream provider
receives the same canonical conversation and every aliased tool is covered.

The permanent regression was observed failing before the fix and passing after
it with this command from `agents/`:

```bash
PYTHONPATH=tests/blackbox:. python - <<'PY'
import asyncio, runpy
ns = runpy.run_path('tests/blackbox/llm.blackbox.py')
asyncio.run(ns['test_build_llm_messages_derives_tool_result_name_from_call_id']())
PY
```

Before the fix it failed on `tool_msg["name"] == "spawn_agent"`; afterward it
exited 0. The full LLM and Rose blackbox suites also exited 0. The exact
four-task AgentCard rerun passed 4/4; `agent-payment-setup-resume`, which had
exposed this mismatch, passed in 215 seconds, and
`agent-payment-idempotent-abandonment` passed in 276 seconds through the funded
fallback.

At 10,000 agents the repair stays request-local and linear in each request's
existing tool-call/message count. It adds no shared state, I/O, polling, or
cross-agent fan-in.

## Human feedback

None recorded.

## Reusable lesson

Derive every matched tool-result name from its assistant call ID at the shared message-construction boundary.
