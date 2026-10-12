---
id: 2026-10-12-chat-decided-escalation-before-search-evidence
date: 2026-10-12
title: Chat chose escalation before its web search ran, so a search miss could only end in a "nothing came up" reply
surface: back-end
component: chat-handler / web_search branch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/chatHandler.ts handleChatMessage — the web_search branch always ran the Generator (schema {reasoning, response}, no action) after the search; the only start_superintelligence branch was on the Router decision made before the search result existed
symptoms:
  - I ran a search with those details and nothing came up as a clear match
  - One more detail would help
  - chat asked a clarifying question instead of starting the Cloud Agent
  - Manual escalation to agent mode
  - search wasn't able to find the result, should escalate to cloud agent
tags:
  - chat-router
  - chat-generator
  - web-search
  - start-superintelligence
  - escalation
  - decision-before-evidence
sources:
  - agent 572da2a5-4fc0-45f4-b9a7-d20b08e19a4e
repro: back-end/src/tests/blackbox/chat-search-escalation.blackbox.ts (exact prod turns 1 and 2 plus a two-city question; request-keyed recordings of pre- and post-fix code)
status: fixed
---

## Problem

Prod agent `572da2a5-4fc0-45f4-b9a7-d20b08e19a4e` (MAC_APP chat, 2026-10-12).
Turn 1: the user described a manga by its plot. The chat Router chose
`web_search`; Parallel returned unrelated titles; the Generator replied "I ran a
search with those details and nothing came up as a clear match" and asked a
clarifying question. Five seconds later the user escalated by hand (Render
01:31:17.793 `Manual escalation to agent mode`); the Cloud Agent named the title
(Uwasa no Midori-kun!!) in about 60 seconds. Turn 2 (another plot-described
manga) ended the same way: "Closest hit … So that's not it … One more detail
would help." The user asked that chat escalate to the Cloud Agent when its
search cannot find what was asked for.

**Archive searches:** `chat web_search no match escalate start_superintelligence
generator clarifying question`; `chat router did not escalate cloud agent search
failed to find result`. Closest hit:
`2026-10-07-chat-router-pointer-as-satisfaction` (router satisfaction rule for
output media). Relative, not a recurrence: that rule lives in the Router, which
here decided before the evidence existed.

## Diagnosis

**Critical path:** USER → `handleChatMessage` → `callRouterLlm` (`web_search`)
→ `executeWebSearch` → `callGeneratorLlm` → `send_message_to_user`. The
Generator schema is `{reasoning, response}`; no step after the search can
choose `start_superintelligence`.

All replays use the in-process client path (`createStreamingCompletion` +
`build{Router,Generator}CompletionOptions`, rose-1-flash on direct-cerebras,
qwen-3.8-27b, temperature 0, parsed by `StructuredOutputAccumulator`), with
contexts rebuilt from the persisted prod rows:

1. Pre-search Router on both turns reproduces prod's query and reasoning byte
   for byte (the rebuilt contexts are the prod contexts).
2. Post-search Generator: 3/3 "didn't come up" plus questions (the symptom).
3. Post-search Router with its full action set: 5/5 `web_search` again ("The
   initial search didn't surface a clear match"). The action chooser sees the
   miss; chat never asks it.
4. Post-search Router limited to `[direct_answer, start_superintelligence]` but
   with the unchanged prompt: turn 1 escalates; turn 2 answers directly, and a
   GLM fallback answered directly while reasoning "A refined search is
   required". The prompt still lists `web_search` and "route to web_search"
   while the schema forbids it: the same contract contradiction one step on.
5. The same route with a stage-consistent prompt (action list and Step 2
   rendered for after the search) escalates exact turn 2 under four histories:
   prod, precedent removed, turn 1 as the fix would leave it, and a visible
   escalation marker. With the base prompt, `rose-1-ultra` (gpt-6-sol) also
   escalated exact turn 2: the outcome is contract-sensitive, and the owned
   contract fix is sufficient on the production model. Under the base prompt
   two contexts also truncated deterministically (`finish=length` at the 1,024
   completion-token router cap, about 3.5k chars of hidden reasoning), which
   production would retry once and then fail; under the stage prompt no call
   truncated, with at most 943 of 1,024 tokens used.
6. All 31 real prod chat web_search turns in 45 days (deploy-gate prompts
   excluded), labelled from the prod reply and the user's next message
   (21 answered, 8 missed, 2 partial), replayed on their exact contexts:

   | after-search route | answered (21) → escalated | missed (8) → escalated | partial (2) → escalated |
   | ------------------ | ------------------------- | ---------------------- | ----------------------- |
   | base prompt        | 1 (+1 length-truncated)   | 1                      | 0                       |
   | stage prompt       | 2                         | 4                      | 1                       |

   The two answered-turn escalations are defensible (a user correcting
   wrong-city cafe results; a fuzzy movie identification). The misses that
   still answer directly returned plausible but wrong content (SF gaming cafes
   from other cities, a Caltrain pointer).

7. Forced Cerebras 429 (production failover), stage prompt: 12/12 valid
   decisions (11 GLM, 1 OpenRouter qwen), no parse misses. The 4 manga misses
   escalate, the 2 non-manga misses (p21, p30) answer directly, and 6/6 hits
   answer. Prod 7-day logs: 925 chat router decisions, 0 router
   regenerate-budget exhaustions.
8. Deploy-gate prompts under the stage prompt: the semantic web_search prompt
   ("Search the web for today's Parallel Search Turbo latency announcement…")
   answered directly 5/5. The `chat-mode` smoke ("whats the latest news?")
   escalated 3/3 when Parallel returned CBS navigation boilerplate and stale
   local items; on the same results the base prompt answered directly. Passed
   benchmark agents are deleted after the run.

**Step 5a:**

1. The user got "nothing came up" instead of the Cloud Agent: the Generator
   wrote it.
2. The Generator is the only step after the search and has no action.
3. The Router owns escalation and mode selection but never sees a tool result:
   the fixed Router → Search → Generator sequence decides before the evidence,
   so "if chat cannot fully satisfy the request, escalate" is unenforceable on
   the search path.
4. Next rung ("merge chat into the SMS supervisor tool loop") is an
   architecture change. Stop at 3.

The SMS supervisor, a tool loop, already documents `start_new_agent` for
"follow-ups after web_search returns thin or stale results".

**Step 5b (LLM-visible: router prompt stages, `queries` schema, the
spent-budget schema):** stopped at "a post-tool step lacks the actions of the
pre-tool step, and each stage's prompt must offer exactly the actions its
schema allows". A bounded Router ↔ search loop with the full action set (the
golden references' shape) was first judged too slow for chat; the user directed
it (see Human feedback), and the measurements below support it.

**Search loop, measured live (real prompts, schemas and stages):**

- Exact turn 1: the first route fans out into 3 queries; the loop either names
  Uwasa no Midori-kun (the title the Cloud Agent verified) or escalates after 3
  rounds.
- Exact turn 2: escalates in 4/4 trials once the post-search Step 2 says that
  asking the user to narrow it down is not a direct_answer. Without that rule
  the turn-1 clarifying-question precedent made it answer "none match, tell me
  more" (3/4).
- Telling the after-search route the round limit made qwen miscount ("three
  rounds exhausted" after two) and give up; the limit is stated only on the
  spent-budget stage, which enforces it.
- `maxItems` on `queries` broke Cerebras constrained decoding (the model looped
  inside its last allowed string until truncation), so the schema has no cap
  and the round runs at most 4 searches at once.
- Hits (two cities, BTC vs ETH, World Cup, the deploy semantic prompt, news):
  2-3 parallel queries, then a direct answer.
- All 31 real prod chat web_search turns in 45 days through the loop: 20/21
  answered turns still answer (1 escalates: "next Caltrain" with no station);
  missed turns now name the right answer by searching again (turn 1, the
  Ecuadorian "Chakana" cross) or escalate (turn 2). Residual: in long
  conversations full of earlier misses (Caltrain live times, SF gaming cafes)
  the route still answers with a limitation.

**Step 6a:** a single post-search step that answers or escalates (Generator
with an action field) was rejected: it duplicates the Router's mode-selection
contract and streams a reply before the decision. The fix reuses the Router and
the existing speculative-Generator gate, and the prompt stages share one
template.

**Residual (open):** limitation replies in long conversations whose earlier
turns already missed (above). A manual escalation writes no row the Router sees
(`startAgentMode`).

**Golden reference:** `claude-code-src/src/query.ts:834` (a `tool_use` sets
`needsFollowUp`) and `:1716` (tool results recurse to the same model; `maxTurns`
bound at `:1704`); `codex/codex-rs/core/src/session/turn.rs:574`
(`needs_follow_up` after tool calls); `hermes-agent/agent/turn_tool_round.py:271`
(follow-up turn after tools). All three return tool results to the model that
chooses the next action and allow parallel tool calls. The fix converges: search
results go back to the Router, which may search again with parallel queries,
bounded by MAX_CHAT_SEARCH_ROUNDS (3) as Claude Code bounds by maxTurns.

## Solution

On branch `fix/chat-escalate-after-search-miss`; the LLM-visible changes were
approved as RCA-572-B on 2026-10-12:

- `routerDecision.ts` / `routerDecisionJsonSchema.ts`: `web_search` carries
  `queries` (one or more, run in parallel); legacy cached `query` decisions
  replay as one query. Stages `initial`, `after_search`, `search_budget_spent`;
  the spent stage's schema has no `web_search`, and a provider that returns one
  there is a typed parse miss.
- `chatPrompts.ts`: one router template renders three stages. The first route's
  actions and Step 2 say to give several queries for several parts or
  phrasings and that results come back for another route. The after-search
  route asks whether the results contain what was asked: answer, search again,
  or escalate; a "not found" report or a clarifying question is not an answer.
  The spent stage can only answer or escalate.
- `chatWebSearchRound.ts`: one round runs every query in parallel (at most 4 at
  once, via the shared `providers/concurrency.ts`) and persists one tool result
  per query in query order.
- `chatHandler.ts`: Router → round → Router … until it answers or escalates; the
  Generator overlaps each after-search route and is committed only on
  direct_answer. `resolveGeneratorMessages` became dead and was removed.
- `routerLlm.ts` / `routerJsonStream.ts`: per-stage prompt, schema and call site
  (`chat_router_after_search`); partial-JSON recovery reads the `queries` array;
  early chip detection reads its first complete query.
- Tests: `chat-search-escalation.blackbox.ts` replays exact turn 1, exact turn 2
  (seeded with the real history) and a two-city question from recordings keyed
  by exact request (pre- and post-fix requests both recorded). Pre-fix: turn 1
  "replied: I ran a search with those details and nothing came up…", turn 2
  "replied: Closest hit from the search is Shuumatsu no Harem…", two-city
  question ran one combined query and answered only Paris. Post-fix: 3/3 pass
  (turn 1 names Uwasa no Midori-kun, turn 2 escalates after searching again, the
  two-city question runs two parallel queries and answers once).
  `chat-router-phase-sync` checks every stage's listed actions against its
  schema; router stream/partial tests cover `queries`.

**10k-agent:** per web_search turn, one router call per search round (up to 3
rounds) and the round's queries in parallel (at most 4 in flight), all keyed to
the one agent with no new channel, lock or fan-in. Provider token quota and
Parallel request volume are the shared resources: a turn can now cost up to 4
router calls and several searches instead of 1 router call and 1 search.

## Human feedback

2026-10-12: the user rejected the one-search design (after the search the
Router could only answer or escalate): "after websearch it should be able to
websearch again, ALSO, it should be able to emit multiple web searches (make
sure the chat mode system prompt makes that clear)". The user approved the
resulting search-loop design (RCA-572-B) the same day.

## Reusable lesson

When a pipeline commits to its action before a tool runs, send the tool result back to the component that owns the next action (search again, answer, escalate), and give each stage a prompt that offers exactly the actions its schema allows.
