---
id: 2026-09-30-chat-router-finaltext-killed-create-on-empty-failover
date: 2026-09-30
title: Chat router called finalText() on an empty failover stream, so a brand-new agent was marked FAILED
surface: back-end
component: chat-router
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/routerLlm.ts — StructuredOutputAccumulator.finalText() after the 3s completion deadline on a zero-item stream
symptoms:
  - 'Chat handler error: Expected one structured output item, received 0'
  - 'This agent instantly died???'
  - 'status: FAILED'
  - 'cerebras_chat.pre_content_failover_to_waterfall'
tags:
  - chat
  - structured-output
  - cerebras
  - failover
  - create-agent
  - cardinality
sources:
  - agent 6e645c29-4b6f-4d87-9478-22ecb28ebba5
repro: back-end/src/tests/blackbox/chat-router-stream.blackbox.ts
status: fixed
---

## Problem

MAC_APP created prod agent `6e645c29-4b6f-4d87-9478-22ecb28ebba5` at
2026-09-30T14:36:39.886Z with goal "buy me nicotine step 1 patches and step 2,
and buy me newest airpods w noise cancelling". By 14:36:44.696Z the row was
`FAILED` with `status_message="Chat handler error: Expected one structured
output item, received 0"`. `temporal_workflow_id` stayed null. The transcript
had only the USER goal.

Render logs: `[ChatHandler] Processing message` → Router + speculative
Generator both started `rose-1-flash`/`direct-cerebras`/`qwen-3.8-27b` →
Generator `direct_cerebras.done` (460ms) → Router Cerebras 429
`token_quota_exceeded` at T+95ms → `cerebras_chat.pre_content_failover_to_waterfall`
+ `openrouter.start` → `ERROR [Agents] Chat handler error` at T+3.027s with
the cardinality string. No `[RouterLLM] First chunk`.

Archive searches (relative, not a recurrence): the exact cardinality string;
`Chat handler error agent instantly died FAILED`; `cerebras 429
token_quota_exceeded pre_content_failover chat router`. Closest:
`2026-07-19-final-text-called-outside-the-supervisor-try-catch` (same throw,
SMS seam only — the guardrail never reached chat router);
`2026-07-16-chat-pinned-to-cerebras-with-no-non-cerebras-failover` (429
escape hatch started here; the chat-layer `finalText()` still terminalized
it). Not the 2026-09-28 context-overflow case.

## Diagnosis

Critical path: POST `/api/agents` → `startChatMode` → `handleChatMessage` →
`callRouterLlm` → Cerebras 429 → OpenRouter failover → 3s deadline →
`finalText()` → `failAgentIfStillActive`.

The 429 is third-party (Cerebras TPM). Failover started as designed. Data
first goes wrong when the empty/incomplete failover stream is passed to
`finalText()` (`requireExactlyOne=true`). That throw is the exact
`status_message`. `parseRouterDecisionAfterDeadline` never ran.

Step 5a: why was the throw possible? The July 19 SMS guard (`currentText()` /
empty `tool_calls` inside the degrade path) was never applied to chat
router/generator — every `finalText()` caller can still convert a normal
empty stream into an unhandled exception. Why did that kill the row? Create
mapped any `handleChatMessage` rejection to `failAgentIfStillActive`; the
follow-up message route already persisted an apology and left ACTIVE.
Stop: Cerebras TPM remaining and whether OpenRouter would have emitted after
3s were not captured — do not relax the 3s bound or invent a first-turn
speculation load-shed from correlation.

## Solution

`finalizeRouterDecisionFromStream` uses `currentText()` only. Empty /
reasoning-only / deadline-expired streams return `decision: null` — never
`StructuredOutputCardinalityError`. Generator uses `currentText()` too.
`recoverChatHandlerFailure` is the single create+message policy: persist the
existing apology, do not `failAgentIfStillActive`.

The 3s completion bound is unchanged. First-turn speculation is unchanged.
A Cerebras 429 remains a third-party miss; if the router still has no
decision the user sees the apology and can retry, instead of a dead agent.

Cemented in `back-end/src/tests/blackbox/chat-router-stream.blackbox.ts`.
Pre-fix: `StructuredOutputCardinalityError: Expected one structured output
item, received 0`. Post-fix: `PASS chat-router-stream (5 cases)`.

10k-agent behavior: O(1) work per chat turn on that agent. No shared fan-in.

## Human feedback

None recorded.

## Reusable lesson

Never call `finalText()` on a chat or SMS degrade path — an empty structured
stream after provider failover must not mark a new agent FAILED.
