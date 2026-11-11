---
id: 2026-11-11-router-fallback-race-latched-first-content-not-completed-decision
date: 2026-11-11
title: After a Cerebras 429 the router's fallback race latched GLM at its first chunk, so an unclosed decision ran to the 15 s router deadline while the Qwen leg never started
surface: back-end
component: rose-client exclusiveCerebrasChatRoute raceDirectCerebrasOpenRouterFallbacks
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/rose/exclusiveCerebrasChatRoute.ts raceDirectCerebrasOpenRouterFallbacks — isContent latched router_decision on the first content chunk, while the router can only act on a completed JSON decision
symptoms:
  - "web_search sample 4 missed milestones"
  - "route: locator.waitFor: Timeout 15000ms exceeded"
  - "[RouterLLM] Completion deadline expired without a decision"
  - "openrouter_fast_chat.end call_site=chat_router duration_ms=14958 end=caller_aborted abort_reason=Chat router completion exceeded 15000ms"
  - "cerebras.error status=429 then openrouter.start model=z-ai/glm-5.3-flash with no qwen/qwen3.8-27b leg"
tags:
  - chat-router
  - structured-output
  - openrouter
  - glm
  - cerebras-429
  - hedged-race
  - latency-ratchet
sources:
  - agent 9e369cc8-3ee0-47aa-a730-85ecd6998981
  - commit 84853969a28a17752b2edb2b868dd95a9339f0ec
  - commit ebe427a5e97f0e24f865d5befe2564d9768bf399
  - commit 4605391fd
repro: back-end/src/tests/unit/chat-generator-rate-cap-completion-race.test.ts (router_decision scenario)
status: fixed
---

## Problem

After PR #1933 fixed the web_search latency prompt, the production semantic gate
for main 84853969a (GitHub Actions run 43049162124, job "Chat full-lifecycle
latency ratchet (web_search)") failed sample 4/5. Both the route milestone
(web_search tool row FINISHED) and the terminal milestone timed out at 15 s.
The other four samples routed in 1.8–4.3 s. This is a different first-bad
boundary from 2026-11-11-test-prompt-asked-for-nonexistent-dated-fact-router-escalated:
the router never reached a decision at all.

## Diagnosis

Production Render logs for agent 9e369cc8 (sample 4):

1. 15:34:26.701 initial router starts. Request 4cd404c8b872: direct Cerebras
   returns 429 at 26.758 (every Cerebras call in that window was 429; two
   production ratchet runs overlapped, 15:27 and 15:31).
2. The rate-cap fallback (`raceDirectCerebrasOpenRouterFallbacks`,
   hedgeDelayMs 500) starts the GLM fast-chat leg at 26.759 (host Morph). Its
   first content arrives at 441 ms. `isContent` latched the race on that first
   chunk because only `generator_response` used `latchOnComplete`. The
   same-model Qwen leg was therefore never started.
3. GLM then streamed 75 chunks / 825 JSON chars without closing the decision
   until the router deadline aborted it at 41.716
   (`Completion deadline expired without a decision ... actualModel=z-ai/glm-5.3-flash chunksReceived=75 jsonLength=825`).
4. The router retried (request d51d6970edbc). This time GLM's headers took
   1,186 ms, so the Qwen leg started at 500 ms and both legs raced; GLM won
   (`fallback_race_done winner=openrouter-fast-chat`) and the decision closed
   at 45.083, about 18.4 s after the turn started, past the 15 s milestone.

Live reproduction at the owning boundary: the exact router request through the
real `createStreamingCompletion` path with Cerebras forced to 429 and real
OpenRouter legs (n=15 each, receipts in
`docs/handoffs/pr-1933-closeout/failover/`):
- unfixed main: every request latched GLM; only 6/15 closed a decision,
  6/15 took over 13 s and 3/15 hit the 15 s abort (p50 11.9 s).
- fixed: 15/15 closed decisions, p50 1.48 s, max 2.2 s; the Qwen leg won
  13/15 and GLM 2/15.

Why GLM stalled: replaying the router request through the production
failover body pinned to single GLM hosts reproduced two tails. Some streams
were slow but completed (Morph 16–17 s for about 600 chars). Others were
runaway decisions that never closed the `queries` array, repeating
near-duplicate queries up to 27k chars. Without `max_tokens` (5/6 Morph,
3/6 Wafer, 3/6 BaseTen, 2/6 Together over 13 s) and with production
`max_tokens: 2048` (Wafer 1/9, BaseTen 1/9, Morph 0/9), the tail moves between
hosts. The unpinned latency-sorted body chose Modal 15/15 in 1.4–2.3 s at
replay time. Host exclusion therefore does not fit the evidence.

Step 5a ladder:
- Why 1: the router deadline expired. GLM's stream did not close a decision.
- Why 2: no faster leg could replace it. The race latched on GLM's first
  chunk and never started the Qwen hedge.
- Why 3: the latch rule distinguished by schema name (`generator_response`)
  instead of by what makes a reply usable. Every json_schema chat reply is
  usable only once complete; the router parses a closed decision
  (`finalizeRouterDecisionFromStream`). That is the deepest owned cause.
  The GLM tail itself is third-party model/host behavior.

Rejected alternatives: `maxItems` on `queries` (already rejected in bcee7f02c:
Cerebras constrained decoding looped inside the last string), and excluding
Morph (the tail moved between hosts across replays).

## Solution

On the rate-cap (Cerebras 402/429) path, `raceDirectCerebrasOpenRouterFallbacks`
now latches every `response_format.type === 'json_schema'` reply on its first
clean completion. Previously only `generator_response` did; the 4605391fd
exemption assumed router decisions were tool calls, but the router now emits
a json_schema decision that `finalizeRouterDecisionFromStream` can use only
when closed. A structured leg that ends with `finish_reason: length` (unclosed
JSON at its token cap) now fails before the latch and drops out of the race,
so it cannot beat a leg that finishes cleanly. Plain text and tool-call
streams still latch at first content. Pre-latch chunks stay buffered per branch
and are replayed only for the winner, so callers still see one provider's
output.

Trade-offs (from the adversarial review):
- Under Cerebras 429, router reasoning tokens and early action detection
  (`webSearchDetectedEarly`, speculative-generator discard) now arrive when
  the winning decision closes. That was 1.4–2.2 s live for this request. The
  older note in `routerCompletionDeadline.ts` measured 4.1–19.1 s on a 24k-token
  router context, so the first-response reporting target (1 s, warn-only) can
  slip under failover. The functional milestones are unchanged.
- Each structured call during a 429 storm now almost always makes two
  OpenRouter requests (the second leg starts at 500 ms unless the first has
  already completed), plus the loser's tokens until it is aborted.
- A failover-served router attempt that hits the deadline no longer surfaces
  partial JSON, so deadline salvage of a closed decision and the
  `chunksReceived`/`jsonLength` diagnostics read 0 in that case. A partial GLM
  stream would not have been actionable anyway (`queries` must be closed).

Residual, not changed: the silent-stream path (Cerebras silent, not 429) still
latches its inner fallback race on first content; it has no production
occurrence and changing it would also stop progressive generator streaming
there.

Regression: `chat-generator-rate-cap-completion-race.test.ts` runs three
scenarios. The original generator scenario. A `router_decision` scenario:
Cerebras 429; GLM's first chunk at 50 ms but unclosed until 1.5 s; Qwen, started
at 500 ms, completes at about 1.25 s. A truncation scenario: GLM completes first
at 300 ms with `finish_reason: length`. Before the fix both router scenarios
returned GLM's unclosed JSON
(`AssertionError: router_decision: first completed answer wins`); after it,
Qwen wins. Passed 5/5 consecutive runs. With only the truncation guard removed,
the truncation scenario fails again. Local backend blackbox domains passed:
cerebras (one transient live `/models` probe miss, then pass on rerun),
chat-cerebras-fallback, openrouter-fast-chat, openrouter-cerebras,
chat-router-failover, chat-router-stream, chat-router, chat-search-escalation
and chat-reasoning-identity.

Sibling failures prevented: no structured chat call on the rate-cap failover
(router initial and after-search stages, generator, and future json_schema
direct-cerebras call sites) can be locked to a leg that streams early but
never closes, or that stops at its token cap.

10k-agent behavior: per-request racing only, with no shared state, channel or
per-user fan-in. Cost: during a Cerebras 429 storm, which correlates with load,
structured chat calls make about 2x OpenRouter requests (one extra per call).

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A hedged race must latch on the moment a reply becomes usable for its caller:
structured (json_schema) replies on their completion, not their first chunk.
