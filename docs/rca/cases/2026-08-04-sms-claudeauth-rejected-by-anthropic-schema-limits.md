---
id: 2026-08-04-sms-claudeauth-rejected-by-anthropic-schema-limits
date: 2026-08-04
title: Every SMS-supervisor claudeAuth round was rejected by Anthropic and fell to the paid waterfall
surface: back-end
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/rose/transforms.ts::extractToolsFromResponseFormat accepted only a `const` discriminator, so the discriminated-union envelope never became native Anthropic tools
symptoms:
  - 'anthropic.error status=400 Schemas contains too many parameters with union types (27 parameters with type arrays or anyOf) ... limit: 16'
  - 'anthropic.error status=400 A maximum of 4 blocks with cache_control may be provided. Found 5.'
  - waterfall.done claude_auth_failed=RoseInvalidRequest on every SMS-supervisor round
tags:
  - sms-supervisor
  - rose
  - claude-auth
  - structured-output
  - prompt-caching
sources:
  - memory: Render prod logs 2026-08-03, 20 union-limit rejections in one window
  - memory: blackbox runs 1785862537-45142-3548 and 1785862932-52590-11344
repro: back-end/src/tests/blackbox/rose.blackbox.ts (claudeAuth / SMS supervisor lifts native tools without unions; claudeAuth / body stays within the cache_control block budget)
status: fixed
---

## Problem

Every SMS-supervisor LLM round that carried a user Claude token was rejected by
Anthropic with `400 invalid_request_error` and fell through to the paid
waterfall, which served the request on a weaker model. Prod Render logs show the
rejection repeating (20 hits in a single sampled window on 2026-08-03), and the
local acceptance reproduced it on the first claudeAuth round:

```
WARN [RoseTransport] anthropic.error status=400 body={"message":"Schemas contains
too many parameters with union types (27 parameters with type arrays or anyOf).
... (limit: 16 parameters with unions)"}
INFO [Rose] waterfall.done pool=rose-1-lite claude_auth_failed=RoseInvalidRequest
```

The user-visible cost was silent: SMS still answered, but never on the model the
user's own Claude subscription pays for. Several SMS RCAs had already blamed
"the degraded Kimi route" for poor tool selection without asking why that route
was reached at all.

## Diagnosis

1. `supervisorHandler.ts` passes `SUPERVISOR_RESPONSE_SCHEMA` (built from
   `z.discriminatedUnion('tool', …)`) as an OpenAI-shaped `response_format`.
2. `claudeAuth.ts::buildAnthropicBody` → `applyAnthropicToolConfig` first tries
   `extractToolsFromResponseFormat`, which lifts each union variant into a
   native Anthropic tool with its own small schema.
3. That extractor required the variant discriminator to be spelled
   `const: "name"`. `z.discriminatedUnion` emits `enum: ["name"]`, so the
   extractor returned `null` for every Rose envelope and the body fell back to
   the legacy single-schema `output_config` path.
4. That single schema declares 27 `anyOf: [T, {type:"null"}]` parameters — the
   encoding OpenAI strict mode forces for optional fields. Anthropic caps a
   request at 16, so it rejected the request outright.
5. With the discriminator fixed, a second, previously masked rejection
   surfaced: the SMS prompt splits its system text into several cacheable
   sections, and those markers plus the message and tool breakpoints exceeded
   Anthropic's four-`cache_control`-block limit.

Both boundaries are ours: neither is a model or provider outage, and both are
deterministic — the same request failed 100% of the time.

## Solution

Three changes in the Rose provider layer, all provider-shape adaptation with no
change to the Zod contract other providers see:

- `extractToolsFromResponseFormat` reads the discriminator from `const` **or** a
  single-value `enum`, so `z.discriminatedUnion` envelopes lift to native tools.
- `relaxNullableUnionsForAnthropic` collapses `anyOf: [T, null]` into `T` and
  drops the key from `required` for the Anthropic body only. Anthropic
  expresses optionality through `required`, so the contract is preserved with
  zero unions (27 → 0) while OpenAI/OpenRouter keep their strict shape.
- `enforceCacheBlockBudget` caps a request at four `cache_control` blocks,
  dropping intermediate system breakpoints and keeping the longest cached
  prefix.

This restores claudeAuth for every discriminated-union caller, not just SMS:
the round is served by the user's own token at $0 Rose cost instead of a paid
waterfall hop, and it removes one guaranteed-failing provider attempt per round.
At 10k agents it strictly reduces work — no new queries, locks, or per-agent
state; one fewer rejected upstream request and one fewer fallback per LLM call.

Confirmed live: the real-LLM SMS acceptance now runs on
`actual_model=claude-sonnet-5-claude` with `cache_read_input_tokens=4204`, zero
`anthropic.error` lines, and the previously timing-out purchase case delegates
in ~8s.

## Human feedback

The human rejected an earlier attempt to fix SMS tool selection with
scenario-specific prompt text as overfitting, which is what forced the search
for a mechanical cause. They approved only the `budget_dollars` field
description.

## Reusable lesson

When a provider-specific request keeps failing, read the provider's own error
before blaming the model: a silent fall-through to the waterfall means every
downstream "the model chose badly" conclusion was drawn on a model you did not
intend to call.
