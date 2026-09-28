---
id: 2026-09-28-chat-mode-sent-subagent-rows-estimator-skipped
date: 2026-09-28
title: Chat mode sent explore subAgentId tool rows while the compaction estimator skipped them, so post-completion follow-ups blew the 131k provider window
surface: back-end
component: chat-context-scope
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/initialContext.ts loadChatModelMessages — loaded raw DB messages into Router/Generator without filterInternalSubagentMessages, while estimateContextTokens skipped metadata.subAgentId rows
symptoms:
  - "Sorry — I couldn't generate a response just now. Please try again."
  - 'metadata.source = "chat_handler_failure"'
  - 'Expected one structured output item, received 0'
  - 'context_length_exceeded ... Current length is 825613 while limit is 131000'
  - after agent completes, follow-up chat message breaks
tags:
  - chat
  - compaction
  - subagent
  - context-window
  - post-completion
  - chat-handler-failure
sources:
  - agent 3b5c2813-c8bd-4ddb-a8bf-f7561c1f7125
repro: back-end/src/tests/blackbox/chat-compaction.blackbox.ts (prod agent 3b5c2813 cases)
status: fixed
---

## Problem

Prod agent `3b5c2813-c8bd-4ddb-a8bf-f7561c1f7125` finished an SF-sublet research run
(`attempt_completion` + `completion_summary`). The user then sent a follow-up
("that link doesn't even work / I said I demand 10"). Chat replied with
`Sorry — I couldn't generate a response just now` and
`metadata.source = "chat_handler_failure"`.

Render logs at the failure (2026-09-28T18:34:18–21Z):

- `[ChatHandler] Processing message` then `[RouterLLM] ... messageCount:1866`
- Cerebras `context_length_exceeded` (~825k vs 131k)
- OpenRouter same (~746k vs 131k)
- Failover waterfall started; chat route ended with
  `Expected one structured output item, received 0`

No `[ChatCompaction]` logs — compaction never ran. `context_reset` count on the
agent was 0. Relative to the earlier chat-compaction fixture (3eb68a5c) and to
agent-side case `2026-08-04-compaction-token-accounting-asymmetry-grows-context`
(which rejected a subAgentId hypothesis because the agent loop already filters
those rows). Novel for chat mode: chat never applied that filter.

## Diagnosis

Critical path: USER follow-up → `postMessage` → `handleChatMessage` →
`loadChatModelMessages` → Router/Generator → Rose → provider 400 → empty
structured output → `chat_handler_failure` ASSISTANT notice.

Binary search:

1. Message persisted; chat handler started (logs).
2. Compaction did not run (no ChatCompaction logs; estimate under trigger).
3. Router still received 1866 messages / ~825k tokens (RouterLLM + Cerebras body).

Of 2101 prod messages, 1979 carried `metadata.subAgentId` (explore/browser work
streams). `estimateContextTokens` skips those rows (~124k estimated, under the
167k auto-compact trigger). `routerLlm.ts` / `generatorLlm.ts` still forward
TOOL text regardless of `subAgentId` (~1761 of those rows had non-empty text).

The agent loop's estimator skip is correct only because
`filter_internal_subagent_messages` already removed those rows. Chat copied the
estimator skip without copying the filter — first-bad boundary is
`loadChatModelMessages` assembling unscoped history.

Local repro (prod-shaped fixture): unfiltered estimate 74 / wouldCompact false /
routerTokens ~2M (`failsProvider: true`); after filter, 6 parent-scoped rows /
~52 tokens (`fitsProvider: true`). Cemented in `chat-compaction` blackbox.

## Solution

Port `filter_internal_subagent_messages` to
`back-end/src/providers/chat/contextScope.ts` and apply it in
`loadChatModelMessages` before budget check / Router assembly. Parent-visible
rows stay — including spawn_agent FINISHED bodies that omit `subAgentId` on
purpose (~28 explore summaries / ~47k tokens on this agent). Explore/browser
work-stream rows tagged `subAgentId` drop. Cross-language contract fixtures in
`shared/context-scope/fixtures.json` pin the predicate for Python + TS.
Auto-compact remains for parent-scoped overflow.

10k-agent behavior: O(messages on one agent) once per chat turn; no shared
fan-in. Filtering shrinks chat payloads after long explore trees instead of
shipping megabytes of child tool bodies into Cerebras/OpenRouter.

Sibling failures prevented: any post-completion (or mid-chat) follow-up on an
agent whose transcript is dominated by `subAgentId` TOOL text.

## Human feedback

None recorded.

## Reusable lesson

If a token estimator skips a message class, every path that feeds the model must
strip that class first — never let chat send rows the compact trigger cannot see.
