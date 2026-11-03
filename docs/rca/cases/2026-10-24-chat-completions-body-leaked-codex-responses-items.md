---
id: 2026-10-24-chat-completions-body-leaked-codex-responses-items
date: 2026-10-24
title: Chat-completions bodies forwarded codex_reasoning_items from a Foundry turn, so Cerebras 400ed explore_agent
surface: agents
component: rose-client transforms.transform_messages_for_openai
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/transforms.py transform_messages_for_openai — copied assistant messages verbatim, including Rose-internal codex_reasoning_items / codex_message_items
symptoms:
  - "rose.transport.cerebras.error status=400 error_body_len=210 call_site=explore_agent"
  - "messages.2.assistant.codex_reasoning_items: property 'messages.2.assistant.codex_reasoning_items' is unsupported"
  - "rose.complete.cerebras.fall_through reason=RoseError"
tags:
  - cerebras
  - foundry
  - codex
  - rose-flash
  - provider-400
sources:
  - agent cd92d525-6713-40fc-b4cd-b1d32b23214f (descend-full69-20261023 request f358b41f, 8 explore_agent copies)
repro: agents/tests/blackbox/rose.blackbox.py::test_chat_completions_bodies_drop_codex_history_items
status: fixed
---

## Problem

Eight explore_agent copies in descend-full69-20261023 got HTTP 400 from Cerebras
on `rose-1-flash` and fell through to Foundry. The worker logged only
`error_body_len=210`.

## Diagnosis

Replaying the captured request (dump with 4 messages, span 9c49ea3d866e) through
`build_cerebras_body` against live Cerebras returned the 400 body:
`messages.2.assistant.codex_reasoning_items: property ... is unsupported`.
The previous explore turn had been served by Foundry (`gpt-5.6-luna`), which
stores Responses reasoning items on the assistant message. Only the Responses
transport (`gpt_auth._build_responses_input`) reads them.
`transform_messages_for_openai` copies messages verbatim for every
chat-completions provider (Cerebras, OpenRouter waterfall, Rose Local).
Cerebras validates strictly and rejects the unknown properties.

## Solution

`transform_messages_for_openai` drops `codex_reasoning_items` and
`codex_message_items` from outbound assistant copies. The caller's history is
untouched, so a later Responses leg still replays them. With the fix, the
captured request returns 200 from live Cerebras. Hermes uses the same split:
only its Responses adapter serializes these items
(`hermes-agent/agent/codex_responses_adapter.py:418`), and it pops them on a
provider 400 (`hermes-agent/run_agent.py:463-478`).

10k agents: two dict pops per assistant message per request, with no shared state.

Open gap: `rose.transport.cerebras.error` logs only the body length; this
diagnosis needed a live replay.

## Human feedback

None recorded.

## Reusable lesson

Provider-specific history annotations must be removed at the transform for every
provider that does not consume them; a strict provider turns a leaked key into a
400 for the whole request.
