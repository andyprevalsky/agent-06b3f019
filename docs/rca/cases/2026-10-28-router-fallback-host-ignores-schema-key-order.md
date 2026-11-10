---
id: 2026-10-28-router-fallback-host-ignores-schema-key-order
date: 2026-10-28
title: Chat router fallback host emitted strict-schema keys out of order, deciding last and escalating web_search answers to agents
surface: back-end
component: rose-client openrouter-fast-chat route
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/rose/openrouterFastRoute.ts OPENROUTER_CHAT_LATENCY_PROVIDER — latency-sorted GLM failover admitted InferenceNet, whose strict json_schema output does not keep declared property order
symptoms:
  - "web_search sample 4 missed milestones"
  - "stage=after_search action=start_superintelligence"
  - "cerebras_chat.pre_content_failover_to_waterfall"
  - "\"queries\": [], \"mode\": \"execute\" , \"goal\":"
  - chat web_search question escalated to a full agent workflow after the search already answered it
tags:
  - chat-router
  - structured-output
  - openrouter
  - glm
  - cerebras-429
  - latency-ratchet
sources:
  - agent 6605d632-9a78-48eb-936f-66a70964b020 (local latency ratchet, 2026-10-28)
  - benchmark run 40678326879 (prod chat-lifecycle-ratchet GitHub Actions, web_search sample 4/5)
repro: back-end/src/tests/blackbox/openrouter-fast-chat.blackbox.ts (routes each request by live latency to response_format hosts); live replay of the dumped chat_router_after_search call through buildOpenRouterFastChatBody pinned to inference-net
status: fixed
---

## Problem

The chat-lifecycle latency ratchet's web_search path ("Search the web for
today's Parallel Search Turbo latency announcement. Include CHATWEBSEARCH<hex>
verbatim in the final answer.") intermittently never rendered a final answer
within 15s. It happened locally (agent 6605d632, sample 3, twice across two
runs on 2026-10-28) and in prod (run 40678326879, sample 4/5). After the web
search, the after_search router chose `start_superintelligence`, so chat started a
full agent workflow instead of answering.

## Diagnosis

1. Direct Cerebras (qwen-3.8-27b) returned 429 for the after_search router call
   (`cerebras.error ... status=429`, `pre_content_failover_to_waterfall`). The
   router failed over to OpenRouter `z-ai/glm-5.3-flash`
   (`openrouter_fast_chat.end ... provider=InferenceNet`).
2. The dumped call (`.llm-dumps/6605d632.../chat_router_after_search.json`) shows
   GLM's hidden reasoning concluding "I can answer directly with the found data".
   The structured output then read
   `{"reasoning": "... No need for further search or agent escalation; I'll answer directly ...", "queries": [], "mode": "execute", "goal": "Summarize the Parallel Search Turbo latency announcement ...", "action": "start_superintelligence"}`.
   The strict schema declares `reasoning, action, queries, goal, mode`.
   InferenceNet emitted `action` last, after the model had already written
   an agent `goal`/`mode` (both required for every action). It then picked the
   action that matched the fields it had just written.
3. Replaying that exact call through the production body builder
   (`buildOpenRouterFastChatBody`):
   - Pinned to InferenceNet: 30/30 outputs emitted keys in the order
     `reasoning,queries,mode,goal,action`; 2/30 chose `start_superintelligence`.
   - Pinned to order-keeping hosts (Wafer, BaseTen): 29/29 kept the declared
     order; 0 escalated.
   - All 61 local after_search dumps for this prompt: 56 Cerebras/Qwen calls kept
     `action` second with 0 escalations; GLM/InferenceNet put `action` last in 4 of 5,
     including the 1 escalation.
4. OpenRouter lists InferenceNet with `structured_outputs` support, so
   `require_parameters: true` admits it. Its grammar validates the schema but
   does not keep the declared property order. The router's contract depends on
   that order in two ways: the decision is made before the action-specific fields
   are written, and `chatHandler` detects the action early
   (`webSearchDetectedEarly`) from the partial JSON. Latency sorting picked
   InferenceNet whenever it was fastest.

Deepest owned cause: the failover route trusted provider metadata
(`require_parameters`) as proof that a host honors the whole strict-schema
contract, but declared key order is part of our contract and that metadata
does not cover it.

## Solution

Add `inference-net` to `OPENROUTER_CHAT_LATENCY_PROVIDER.ignore`, next to the
existing measured exclusion `friendli`. The latency-sorted failover keeps its
live ranking and fallbacks among the remaining hosts. The offline regression in
`openrouter-fast-chat.blackbox.ts` (run by backend coverage on `/deploy`) pins
the exclusion and fails on the pre-fix config.

Live repro: the same replay pinned to `inference-net` now gets OpenRouter 404
("All providers have been ignored"), and the unpinned production body lands on
Wafer with `action` second 6/6. No prompt, schema or LLM-visible text changed.

10k-agent behavior: provider routing metadata only. No per-agent state,
queries or channels are added.

## Human feedback

None recorded. Andy's lane constraints: no string-matching classifiers, no
runtime nudges, no latency benchmark changes.

## Reusable lesson

When a structured-output fallback host decides differently from the primary on
the same call, compare the emitted key order with the schema's declared order
before blaming the model or prompt: exclude hosts whose strict-schema output
does not keep declared order wherever the decision or streaming depends on it.
