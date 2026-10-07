---
id: 2026-10-07-chat-router-pointer-as-satisfaction
date: 2026-10-07
title: Chat router treated a pointer to photos as fully satisfying a request to show them
surface: back-end
component: chat-router / ROUTER_SYSTEM_PROMPT
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/chatPrompts.ts ROUTER_SYSTEM_PROMPT — "fully satisfy" is undefined relative to chat's closed output media, so rose-1-flash routes "show me photos" to direct_answer and the generator refuses
symptoms:
  - I can't display images in this chat
  - I can't show images in this chat
  - This chat has no image display
  - Show me photos of both places
  - point them to where photos are available
tags:
  - chat-router
  - direct-answer
  - photos
  - start-superintelligence
  - capability-contract
sources:
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe
repro: back-end/src/tests/blackbox/chat-router-phase-sync.blackbox.ts (closed output-media / satisfaction-as-emission contract)
status: fixed
---

## Problem

Prod agent `3be856d5-e4fe-4eb5-b30e-ea99d44793fe` (goal: gaming cafe near Embarcadero SF) finished a search, then the user asked four times to see photos of Cyber Racoon and Euphnet. Chat stayed on `direct_answer` and sent `send_message_to_user` FYI refusals ("I can't display images here"). The user said "U can show photos". Photos appeared only after a `photos_shown: list[file_pointer]` schema forced PLAN and `spawn_browser_agent`.

Local reconstruction of the first photo turn (messages 0..171, `filterInternalSubagentMessages` → 64 scoped / 53 OpenAI turns) replayed through `createStreamingCompletion` + `buildRouterCompletionOptions` (rose-1-flash, `direct-cerebras`, temp 0, `router_decision` schema):

- 3/3 full-context router trials: `action=direct_answer`, reasoning "I can't display images in chat, but I can point them to where photos are available... This is a simple direct answer."
- 3/3 generator trials on the same context: "I can't show/display images here" plus Maps/website pointers.
- Same model + prompt on the last four turns only: 2/2 `start_superintelligence` ("requires browsing... to retrieve and display photos").
- Full context on rose-1-ultra (not the production chat router): `web_search`, still not escalate.

Sibling, not this first-bad: static `FadeInMarkdown` dropped `<img>` (case `2026-10-07-fadein-markdown-dropped-photos`). This trajectory never emitted markdown photos or file_pointers on the refusal turns.

**Archive searches:** `I can't display images in this chat`; `point them to where photos are available fully satisfy start_superintelligence`. Hits were the sibling renderer case and unrelated chat-router failover/compaction cases. Novel class, not a recurrence.

## Diagnosis

**Critical path:** USER "Show me photos of both places" → `handleChatMessage` → `callRouterLlm` (`ROUTER_SYSTEM_PROMPT`) → `direct_answer` → `callGeneratorLlm` → FYI refusal → no `file_pointer` / no `start_superintelligence`.

**First-bad:** the router prompt says "never reject" and "escalate if chat cannot fully satisfy" but never defines satisfaction as emitting the requested representation, and never lists chat's closed output media (text only; generator schema is `{reasoning, response}` and `USER_FACING_WRITING_STYLE` says AVOID markdown). The model treats a Maps/website pointer as fulfillment. Long post-completion history makes that worse: the identical prompt escalates on a short tail.

Not model-intelligence: the production router model escalates on the reduced context; ultra on the full context still does not choose `start_superintelligence`.

**Step 5a:**

1. User sees no photos — generator FYI refusal.
2. Router chose `direct_answer` (3/3 live replay).
3. "Fully satisfy" is underspecified vs chat's actual media, so a pointer counts as an answer.
4. Next why ("build a global capability graph for every surface") leaves this module and requires an utterance→media classifier (rule 25b). Stop.

**Step 5b (prompt edit):**

- Stopped at: a surface without an output medium still claims to satisfy a request that requires that medium; satisfaction is not defined as emitting the representation.
- Next-deeper tried: one product-wide capability graph every surface consults before acting.
- Why that fails to be coherent: it is a new architecture plus a user-intent classifier. The owned fix is to declare this surface's closed media and satisfaction rule where routing already decides.

**Golden reference:** Codex realtime backend (`prompt-review/rendered/codex/codex_realtime_backend.txt:33`, source `codex-rs/prompts/templates/realtime/backend_prompt.md`) — "Do not claim that you cannot perform some actions. ALWAYS delegate." Claude Code `claude-code-src/src/utils/markdown.ts:139` keeps image tokens (sibling renderer only).

## Solution

Approved prompt/schema contract (not photo-specific): `ROUTER_SYSTEM_PROMPT` now declares chat's closed output media and defines "fully satisfy" as emitting the requested representation. A pointer, limitation, or "go look on Maps" is a rejection and must be `start_superintelligence`. A finished agent run does not shrink that rule. The router JSON `action` description repeats the same bound.

Identical full-context live replay after the change: 3/3 `start_superintelligence` ("This surface cannot emit images. Escalating to agent to fetch and deliver photos").

Cemented by `chat-router-phase-sync.blackbox.ts` ("router prompt defines closed output media and satisfaction as emission"). Sibling markdown renderer remains a separate case.

**10k-agent:** O(1) prompt tokens on the existing per-agent router call; no extra subscriptions or fan-in.

## Human feedback

None recorded.

## Reusable lesson

If a chat surface cannot emit a requested representation, routing must escalate — describing where that representation exists is a rejection, not a satisfaction.
