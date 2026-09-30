---
id: 2026-09-30-chat-router-finaltext-killed-create-on-empty-failover
date: 2026-09-30
title: Chat treated the first empty structured-output stream as a terminal handler failure
surface: back-end
component: chat-router
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/routerLlm.ts — first empty/deadline/parse miss threw out of handleChatMessage instead of regenerating in place
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
  - retry
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
SMS already regenerates — the guardrail never reached chat);
`2026-07-16-malformed-structured-output-failed-agent-without-regenerating`
(agent helper already regenerates; chat did not). Not the 2026-09-28
context-overflow case.

## Diagnosis

Critical path: POST `/api/agents` → `startChatMode` → `handleChatMessage` →
`callRouterLlm` → Cerebras 429 → OpenRouter failover → 3s deadline →
`finalText()` → `failAgentIfStillActive`.

The 429 is third-party (Cerebras TPM). Failover started as designed. Data
first goes wrong when an empty/incomplete failover stream is treated as a
terminal handler error. `finalText()` (`requireExactlyOne=true`) produced the
exact `status_message`, but that throw is a symptom of the class: chat had
no SMS/agent-style regenerate on empty / reasoning-only / unparseable /
deadline-without-decision streams.

Sibling miss sites in the same class:

- Router: `'Router LLM returned no content'`, `'Chat router completion expired'`,
  `'Failed to parse router response as JSON'`
- Generator: `'Generator LLM returned no content'`, parse failure
- Speculative `commitDirectAnswer()` rethrew those misses and skipped the
  canonical generator (`?? runGenerator`)
- Create mapped any `handleChatMessage` rejection to `failAgentIfStillActive`

An apology-only hook after the first throw is still giving up on a
recoverable miss. July 19: only if every regenerate stays empty does the
terminal net deliver one apology. Stop: Cerebras TPM remaining and whether
OpenRouter would have emitted after 3s were not captured — do not raise the
per-attempt 3s bound.

## Solution

One typed miss (`ChatLlmTransientMissError`) and one regenerate helper
(`regenerateOnChatStructuredMiss`, 2 attempts). Router and generator both
use it. `finalizeRouterDecisionFromStream` still uses `currentText()` only
(never cardinality). `requireRouterDecision` / `requireGeneratorParsedJson`
convert empty / parse / deadline-without-decision into the typed miss.
Speculative commit returns `null` on that miss so the canonical generator
runs. After the budget is exhausted, `recoverChatHandlerFailure` persists
the existing apology and does **not** `failAgentIfStillActive`.

The 3s per-attempt completion bound is unchanged. First-turn speculation
load-shed is unchanged.

Cemented in `back-end/src/tests/blackbox/chat-router-stream.blackbox.ts`.
Pre-fix: first empty stream → cardinality throw → FAILED. Post-fix:
`PASS chat-router-stream (11 cases)` — first miss regenerates; exhausted
miss stays typed and does not fail the agent.

10k-agent behavior: O(1) extra in-process regenerate per chat turn on that
agent (cap 2). No shared fan-in.

## Human feedback

The first product change (don't throw cardinality, persist an apology, leave
ACTIVE) was rejected as too shallow: this class must never happen on the
first miss, and the other chat error cases were on the same incorrect path.

## Reusable lesson

A transient empty or unparseable chat/SMS/agent structured stream must
regenerate in place. Do not fail the agent, and do not apologize until the
bounded regenerate budget is exhausted.
