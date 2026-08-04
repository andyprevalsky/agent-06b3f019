---
id: 2026-07-16-chat-pinned-to-cerebras-with-no-non-cerebras-failover
date: 2026-07-16
title: Chat was pinned to Cerebras-only routes, so a 5-req/min org rate cap became a terminal "No assistant response"
surface: back-end
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/rose chat generator/router — provider_route 'direct-cerebras' / 'openrouter-cerebras' (provider.only:['cerebras']) with only a Cerebras→Cerebras failover, then a terminal throw
symptoms:
  - 'failureReason="No assistant response received"'
  - 'ERROR [Agents] Chat handler error ... Cerebras 402 (request_id=...): {"code":"payment_required","param":"quota"}'
  - benchmark reports $0 cost for the failed chat-mode run
tags:
  - cerebras
  - rose-completions
  - rate-limit
  - failover
  - chat-mode
sources:
  - commit 8ed145776
  - memory:project_cerebras_ratecap_chat_fallback
repro: back-end/src/tests/unit/chat-generator-provider-route.test.ts
status: fixed
---

## Problem

Chat-mode (and message-person) benchmarks failed with
`failureReason="No assistant response received"` and $0 recorded cost. The
backend logged
`ERROR [Agents] Chat handler error ... Cerebras 402 (request_id=...): {"code":"payment_required","param":"quota"}`.
The `payment_required` code reads like a billing outage, but it was not.

## Diagnosis

Three conditions all had to be true:

1. **Local credential drift.** `back-end/.env` and `research/.env` carried a
   different, unfunded `CEREBRAS_API_KEY` (`csk-r5dpex…` → 402) while Render's key
   (`csk-dnt2k2…` → 200) worked. `research/.env` is sourced by the WMH/benchmark
   stack and its `export` shadows dotenv (which will not override an
   already-set `process.env`), so one stale source poisoned the whole stack.
2. **Cerebras org request-rate cap.** Even with the good key, the org is capped at
   **5 requests per minute across all models** (tokens are generous at 1M/hr — it
   is the request rate). One request → 200; five concurrent smoke agents → 402
   `quota`. `zai-glm-4.7` is a Preview model with 8192 context.
3. **No escape from Cerebras.** The synchronous chat generator/router used
   `provider_route: 'direct-cerebras'` and `'openrouter-cerebras'` — the latter
   pins OpenRouter to `provider.only: ['cerebras']`, i.e. still Cerebras hardware.
   The only failover path was `selectDirectCerebrasFailover` (Cerebras→Cerebras),
   followed by a terminal throw.

So a provider-side rate cap that should have been transparently absorbed became a
hard user-visible chat failure. The owned defect is (3): the route had no
non-Cerebras escape hatch.

## Solution

Shipped in `8ed145776` (refactored in `41d3a487f`, same-model hop in `d864c0ee9`):
on a **pre-content** `RosePaymentRequiredError` (402) or `RoseRateLimitError`
(429) from the exclusive Cerebras route, first fall over to the **same model**
(GLM-4.7) via OpenRouter with the provider unpinned —
`provider: {order: ['cerebras'], allow_fallbacks: true}` — so Cerebras is still
preferred but traffic can spill to another GLM-4.7 host past the cap. Only if
that same-model hop also fails pre-content does it drop to the generic waterfall
(GPT/Anthropic/OpenRouter). A real 4xx/5xx or a mid-stream error still surfaces,
so the path fails closed.

Logic lives in `back-end/src/providers/rose/cerebrasChatRouteRunner.ts`
(`runExclusiveCerebrasChatRoute` returns true = completed / false = fall to the
generic waterfall); `openrouterCerebrasRoute.ts`'s `buildOpenRouterCerebrasBody`
takes `allowProviderFallback`. Log lines:
`cerebras_chat.quota_fallover_to_openrouter_glm`, `.openrouter_glm_fallover_done`,
`.openrouter_glm_fallover_failed`. `chat-generator-provider-route.test.ts` asserts
the fallover body uses `model=z-ai/glm-4.7`, `provider.order=['cerebras']`,
`allow_fallbacks=true`, no `only` pin, and never a generic URL.

Raising the org cap itself is a Cerebras-dashboard/tier action on the user side.

## Human feedback

The fallover had to be to the **same model** first, not to a generic waterfall
model — the fix was explicitly re-scoped from "drop to the waterfall" to
"same-model unpinned hop, waterfall only as last resort".

## Reusable lesson

A provider-exclusive route needs a non-that-provider escape on pre-content
402/429, otherwise a request-rate cap surfaces as a terminal "No assistant
response".
