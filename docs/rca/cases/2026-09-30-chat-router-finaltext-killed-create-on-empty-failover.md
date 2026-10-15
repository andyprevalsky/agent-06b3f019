---
id: 2026-09-30-chat-router-finaltext-killed-create-on-empty-failover
date: 2026-09-30
title: Chat treated the first empty or deadline-expired router stream as a terminal handler failure, with a 3s bound that killed every failover
surface: back-end
component: chat-router
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/routerLlm.ts — first empty/deadline/parse miss threw out of handleChatMessage instead of regenerating in place
symptoms:
  - "Chat handler error: Expected one structured output item, received 0"
  - "cerebras_chat.pre_content_failover_to_waterfall"
  - "Sorry — I couldn't generate a response just now. Please try again."
  - "[ChatStructuredRetry] Deadline miss is not regenerated"
  - "Chat handler error: Chat router completion expired"
tags:
  - chat
  - structured-output
  - cerebras
  - failover
  - create-agent
  - cardinality
  - retry
  - deadline
  - openrouter
  - provider-routing
  - recurrence
sources:
  - agent 6e645c29-4b6f-4d87-9478-22ecb28ebba5
  - agent e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6
  - commit cb6c4d6b9
  - PR #1348
repro: back-end/src/tests/blackbox/chat-router-stream.blackbox.ts + back-end/src/tests/blackbox/chat-router-failover.blackbox.ts
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
and `openrouter.start` → `ERROR [Agents] Chat handler error` at T+3.027s with
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
per-attempt 3s bound. (Resolved by the 2026-10-01 recurrence: the failover
profile was captured and the 3s bound was the cause.)

## Solution

One typed miss (`ChatLlmTransientMissError`) and one regenerate helper
(`regenerateOnChatStructuredMiss`, 2 attempts). Router and generator both
use it. `finalizeRouterDecisionFromStream` still uses `currentText()` only
(never cardinality). `requireRouterDecision` / `requireGeneratorParsedJson`
convert empty / parse / deadline-without-decision into the typed miss.
Speculative commit returns `null` on that miss so the canonical generator
runs. After the budget is exhausted, `recoverChatHandlerFailure` persists
the existing apology and does **not** `failAgentIfStillActive`.

The 3s per-attempt completion bound is unchanged (superseded 2026-10-01:
every synchronous chat timeout is 15s from the start of its request or
router attempt). First-turn speculation load-shed is unchanged.

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

2026-10-01 recurrence: "we already rcaed this recently and i thought it
would've been fixed by now, wtf?" Then: "make sure when u cement the test,
that it proves this exact scenario will actually work in prod". A test that
asserts source text, or that only replays recorded streams, does not satisfy
that. The regression test must replay the exact captured context and the real
provider stall/failover timing. `/deploy` must also run a live probe through
the real failover provider.

On the first fix (a 5s no-progress bound inside a 15s cap, a 5s GLM guard,
and the 1.2s Cerebras guard): "thats way to aggresive of a timeout, on chat,
it should be 15s from the juimp / then retry w real data that could show
this issue (the longer the context the more likely to hit timeout)". Every
chat timeout is now 15s from the start of its request or router attempt,
proven on the longest real prod router contexts (see "Fifteen seconds from
the start").

On the 15s approval request (E8F2-2): "direct cerebras should have 8 s
timeout". Direct Cerebras's connect, first-content, and SSE-idle guard is
now 8s. The router attempt and the GLM failover keep 15s, so ending
Cerebras does not end the turn (see "Eight seconds for direct Cerebras").

## Reusable lesson

Regenerate a transient empty, unparseable, or deadline-expired structured LLM stream in place, and size each per-attempt bound from the measured latency of the slowest path allowed to serve (the failover) under the provider routing prod actually gets, on the longest real contexts prod sends, never from the healthy primary on a typical context. Time to first content grows with the context, so a bound that holds at the median context fails the long ones first.

Do not fail the agent, do not substitute a keyword shortcut for the model's
decision, and do not apologize until the bounded regenerate budget is
exhausted.

## Recurrence — 2026-10-01 (agent e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6)

**Symptom.** An agent had completed a hot-yoga run in Irving, TX. The user's
follow-up "wrong address, its the 88 harlow one" (the fixture's stand-in for
the user's building) got `Sorry — I couldn't
generate a response just now. Please try again.` The agent stayed ACTIVE and
no workflow started. Render timeline:

- 03:46:44.231Z: router `cerebras.start` (`direct-cerebras`, `qwen-3.8-27b`,
  30 messages).
- +805ms: the hedge armed `openrouter.start` for `qwen/qwen3.8-27b` and
  `z-ai/glm-5.3-flash`.
- +3.000s: `[ChatStructuredRetry] Deadline miss is not regenerated`, then
  `Chat handler error: Chat router completion expired`.
- 03:46:47.249Z: the apology row was written.

There was no `[RouterLLM] First chunk`.

Archive searches: `Chat router completion expired` and the apology string.
This is a recurrence of this case. Relatives:

- `2026-09-28-chat-mode-sent-subagent-rows-estimator-skipped`: same apology on
  a post-completion follow-up, ruled out. The projected router request is
  88,440 chars (82,649 transcript plus a 5,791-char system prompt; 24,382 GLM
  prompt tokens locally), well inside both models' windows, and prod logged
  no invalid-request or context-length error.
- `2026-07-16-chat-pinned-to-cerebras-with-same-provider-failover`: a Cerebras
  stall is the trigger, but the cross-provider hedge now exists and started on
  time.

**Why the guardrail did not hold.**

1. `cb6c4d6b9` landed after this case. It took deadline misses out of the
   regenerate set ("a second 3s bound cannot recover a slow model"). In their
   place it added `deadlineRouterFallback`, a keyword regex
   (`EXPLICIT_AGENT_INTENT`) that escalated only prompts worded like the
   lifecycle-latency spec. A real follow-up such as "wrong address, its the 88
   harlow one" does not match, so it apologized. That string-matching
   classifier kept the benchmark green while real turns failed.
2. This case's own Stop ("do not raise the per-attempt 3s bound") was treated
   as a standing constraint. The data it was missing (would OpenRouter finish
   after 3s?) was never collected. The bound stayed sized for the healthy
   Cerebras primary (about 0.7–1.1s). During a Cerebras stall, though, the
   OpenRouter failover is the only path that can serve.
3. `cb6c4d6b9` cemented the carve-out with a synthetic-miss attempt count
   (`deadlineAttempts === 1`), two source-text matches (`deadlineRouterFallback`
   in `chatHandler.ts`, `miss.kind === 'deadline'` in the retry module), and
   unit tests of the keyword phrasing. None of them replayed a real failover
   stream on a real-size context, so nothing measured whether a 3s attempt
   could ever finish.

**Second rung, one layer down: the GLM guard.** GLM (`z-ai/glm-5.3-flash`,
the `openrouter-fast-chat` branch) is what serves a Cerebras stall. It had
its own 2s pre-token guard, which counts only content or tool-call chunks.
That guard was sized in `5c90a29ea` for a Flash-Lite model. `8f3c22f31`
swapped in GLM on the strength of a generic 0.48s TTFT figure and kept the
2s guard. On this 24k-token context, GLM's first content came this long
after its request:

- 0.5–1.7s in 19 of 23 runs.
- 2.0–3.1s in 3 runs.
- 7.7s in 1 run.

In prod both rungs fired, and the guard fired first. GLM's request started
at about 03:46:45.036Z (805ms into the turn), so its guard expired at about
47.036Z. The router's 3s bound fired at 47.231Z. No `[RouterLLM] First
chunk` was logged, so GLM had no content by 47.036Z and its guard ended it.
The router bound then ended the turn while only the stalled Qwen spill was
left. Prod could not log the guard: `hedgeStreams` swallowed pre-latch branch
failures. Locally, on prod defaults with the router fix alone, the log reads
`branch=openrouter-fast-chat ... OpenRouter fast chat produced no model
output within 2000ms`, and the exact follow-up apologizes at about 10s.

**The pre-content budget.** The Rose hedge buffers every chunk, reasoning
included, until a branch emits content (`clearsChatStallGuard` accepts only
content and tool calls). So during a Cerebras stall the router receives
nothing from the failover until its first content. The router's 15s attempt
bound therefore gives the failover 15.0 − 0.8 = 14.2s from its own request
to first content and to a closed decision. The 15s GLM guard starts with the
GLM request, 0.8s into the turn, so on the router path it never cuts before
the router's own bound. It binds only for the speculative generator, which
has no router bound. (The first fix used a 5s no-progress bound, which left
a 4.2s pre-content budget; the profiles below that cite 4.2s were scored
against it.)

**Third rung: which GLM host serves.** The fast-chat body sent no provider
preferences and no `session_id`.

- OpenRouter's default routing is price-weighted (inverse square of price),
  so it favors the cheapest of GLM's 33 endpoints. On this request those were
  also the slowest. Prompt prices run from $0.02/M to $0.75/M. InferenceNet
  lists $0.05/M, and the throughput leaders list $0.15/M. Relace and
  AtlasCloud do not list `response_format`.
- After a cached response, OpenRouter keeps a conversation on that host for
  10 minutes. The conversation is keyed on the first system and first
  non-system message, unless `session_id` is set. OpenRouter documents that
  an explicit `order` overrides this pin. In our profile `sort` did not: 16
  of 16 sticky requests sent with `sort: throughput` stayed on InferenceNet.
  That is observed behavior, not documented behavior.
- A Rose stall abort is a client-side cancel, not a provider error, so it
  does not release the pin. The router's regenerate re-sends the same
  conversation and lands on the same host.

It is not proven that the prod turn hit a slow pinned host, because prod
logged no host. Prod now logs one `openrouter_fast_chat.end` record per GLM
request (HTTP status and header time, host and first-event time, first
content, and how it ended, including the caller's abort reason) and
`openrouter.headers` for every OpenRouter stream. Locally it was observed. A live probe on the bound fix with default routing
stuck to InferenceNet (the host comes from the probe output; the capture
file was not retained):

- Attempt 1 waited 3.9s for response headers and hit the stall bound.
- Attempt 2 was at 1,361 of about 1,450 decision chars when the 15s cap
  fired.
- The apology came at 20,077ms.

**Evidence.** Profiles, scoring script, endpoint list, and the Render check
are in the RCA evidence bundle
(`rca_evidence/e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6/profiles/`).

- Prod proves direct Cerebras produced no content within 1.2s and did not
  429: the primary error at 03:46:47.233Z is `RoseStallError`. Locally on the
  exact context, the stall shape (HTTP 200, a role-only delta at about 417ms,
  then silence) was seen on 3 of 15 real-route runs while the replay fixture
  was recorded (its note records the count). Those raw traces were not
  retained; the three retained direct-Cerebras traces are healthy (HTTP 200
  with 99, 75, and 58 events). The fix does not depend on the stall rate.
- Render sets none of the five chat bound variables (`render-env.ts` reports
  each as NOT SET), so prod runs the code defaults.
- Failover profile, n=24, exact context, Cerebras stalled, real OpenRouter,
  timed from the turn start. All 24 went to one pinned host (Together).
  - First content: p50 1.8s, p90 3.8s, max 8.6s.
  - Completion: 4.1–19.1s (p50 6.0s, p90 10.7s). 0 of 24 completed within 3s.
  - Max inter-chunk gap: about 0.4s.
  - Winners: GLM 23, Qwen 1. All 24 chose `start_superintelligence`.
  - Scored for attempt 1 (first content within 5s of the turn start,
    complete within 15s): the old policy (3s bound, 2s GLM guard) served 0 of
    24, the router fix alone 19 of 24, and the router fix plus the 5s GLM
    guard 22 of 24.
- GLM routing profile on the exact captured router request, sent straight to
  OpenRouter. A request serves attempt 1 if its first content lands within
  4.2s of the request, no gap exceeds 5s, and it completes within 14.2s.
  - Pinned to InferenceNet, n=16 per variant: default routing 11 of 16
    (complete p50 12.2s, p90 16.6s), `sort: throughput` 14 of 16,
    `sort: latency` 9 of 16.
  - Fresh session per request:
    - Default routing, n=12: 11 of 12, complete p50 8.4s, p90 11.9s
      (Together 5, InferenceNet 7).
    - `sort: throughput`, n=62 over four runs between 06:00 and 07:15Z: all
      62 served. Complete p50 2.7s, p90 3.4s, max 7.0s; first content max
      3.3s.
      Hosts: Parasail 46, CoreWeave 8, BaseTen 8.
    - Load-balanced throughput floors (`preferred_min_throughput` p50 80,
      with or without `preferred_max_latency` p50 2s), n=62: 60 of 62.
      Complete p90 up to 13.0s, first content up to 4.24s. They spread load
      but still drew slow hosts (InferenceNet took 10 of 30 in one run).
    - An explicit `order` of four fast hosts, n=12: 12 of 12, p50 2.2s.
  - Pinned hosts, n=6 each: from Parasail at 6 of 6 (p50 1.9s) down to Wafer
    at 0 of 6. Modal measured p50 49s, after 8.5s an hour earlier. BaseTen
    returned 429s.
- Evidence integrity: the first post-fix runs inherited
  `OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS=20000` from the Cloud VM environment
  (Render does not set it), so they proved a 20s GLM guard that prod never
  runs. The Step 7 adversarial review caught it. The test now removes every
  inherited chat-path bound override before it runs. The `origin/main` runs
  below also ran under that inherited 20s guard. Their result does not
  change, because the 3s router bound fires first.

**Fix (PR #1348).**

- `cerebrasRoute.ts`: `CHAT_TIMEOUT_MS = 15_000` bounds every router
  attempt and every OpenRouter failover request from its own start, with no
  shorter bound inside it.
- `routerCompletionDeadline.ts`: one deadline per router attempt,
  `CHAT_TIMEOUT_MS` from the attempt's start; progress does not extend it.
  `CHAT_ROUTER_COMPLETION_TIMEOUT_MS` overrides it (Render sets none).
- The direct-Cerebras connect, first-content, and SSE-idle guard goes from
  1.2s to 8s (`DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS = 8_000`). The 0.8s
  hedge still starts the OpenRouter fallbacks in parallel, but no longer
  ends a Cerebras stream that is still prefilling a long context, so that
  turn is neither lost nor re-sent against Cerebras's per-minute token
  limit. When the guard ends Cerebras, the hedged fallbacks keep racing
  until the router attempt's 15s bound.

- `chatStructuredRetry.ts`: deadline misses regenerate again under the same
  2-attempt budget as empty and parse misses.
- Deleted `deadlineRouterFallback` and `EXPLICIT_AGENT_INTENT`, plus their
  `chatHandler.ts` wiring. Deleting them is better than guarding them.
- `openrouterFastRoute.ts`:
  - The GLM guard (pre-token, connect, and SSE idle) goes from 2s to 15s
    (`CHAT_TIMEOUT_MS`), so it never cuts before the router's own bound.
  - GLM requests carry
    `provider: { sort: 'throughput', require_parameters: true }`.
  - Each GLM request names its own session (`rose-fast-chat-<requestId>`),
    so a regenerate does not inherit the conversation-derived pin from the
    first attempt. With `sort`, OpenRouter still picks the current
    throughput leader, so attempt 2 can land on the same host as attempt 1;
    the session removes only the pin, not that correlation.
  - The route logs one `openrouter_fast_chat.end` record per request: HTTP
    status and header time, the serving host and first-event time (from
    OpenRouter's `provider` field), first output and first content, and the
    end (`completed`, `caller_aborted`, `consumer_closed`,
    `no_output_timeout`, or `failed`) with the caller's abort reason.
    `postOpenRouterStream` logs `openrouter.headers` for every OpenRouter
    stream.
- `exclusiveCerebrasChatRoute.ts`: once the caller aborts (the router's
  deadline), a failed hedge rethrows instead of falling through to the
  generic waterfall. The waterfall already refused to start on an aborted
  signal, so no request leaked, but the route logged a false
  `pre_content_failover_to_waterfall`.
- `hedgedStream.ts`: added `onBranchFailure`. Both chat races now log
  `cerebras_chat.hedge_branch_failed` (race, branch, error) unless the
  caller aborted. The Qwen spill branch is renamed from `openrouter-glm` to
  `openrouter-cerebras-spill`.
- The healthy Cerebras path never arms the hedge and is unchanged. The worst
  case before the apology is 2 × 15s = 30s (previously 3s).

Throughput sorting won on the profile: 62 of 62 inside the bounds, against
60 of 62 with a p90 of 13.0s for load-balanced floors. An explicit `order`
measured slightly faster, but it pins every failover to a fixed host list
that goes stale as hosts drift.

**Fifteen seconds from the start: long contexts (2026-10-01).** The first
fix kept the 1.2s Cerebras guard and bounded the router at 5s of no
progress. Review asked for 15s from the start, proven on real data with
long contexts. The prod data (read-only, local copy under
`/tmp/rca/longctx/`):

- 30 days of `chat_router` usage rows (1,913 served turns, 2026-09-01 to
  2026-10-01): router input p50 1,656 tokens, p90 1,697, max 7,031. No
  router turn above 7,031 tokens was served in 30 days.
- 8 router turns in that window ended in the chat apology. 6 of them carried
  long transcripts: 23k–315k chars, 10k–96k Cerebras tokens (agents
  3a7c0315, be5f2781, e8f2279b, a890a362 twice, 3b5c2813). The other two
  (1476ba20, 26576873, 14s apart at 06:10Z on 2026-10-01) were 1.7k-token
  first turns.

Each of those 8 contexts, plus 2 of the longest served ones (5.3k and 7.9k
tokens), was replayed twice through the real `callRouterLlm` (Rose hedge,
race, guards, router bounds, regenerate) against live providers, by an
evidence-only harness (`back-end/.context-rca/replay-long-router-contexts.ts`,
not committed). Scenario "prod" has every provider live; "glm-only" stalls
direct Cerebras and the Qwen spill, so the real GLM failover is the only
path. Cerebras requests were paced under half of the org's 150k
tokens/minute. Served on router attempt 1 (prod apologized on any
attempt-1 miss), with decision times:

| Context (Cerebras tokens)    | prod, old bounds | prod, 15s      | glm-only, old | glm-only, 15s    |
| ---------------------------- | ---------------- | -------------- | ------------- | ---------------- |
| 1476ba20 (1.7k)              | 2/2              | 2/2 (0.5–0.6s) | 1/2           | 2/2 (1.5–2.6s)   |
| 26576873 (1.7k)              | 2/2              | 2/2 (0.4–0.5s) | 2/2           | 2/2 (2.2–10.5s)  |
| d85b0ca9 (5.3k)              | 2/2              | 2/2 (0.5–0.6s) | 1/2           | 2/2 (2.4–3.8s)   |
| 2929bc93 (7.9k)              | 1/2              | 2/2 (1.9–2.2s) | 0/2           | 1/2 (6.0s)       |
| 3a7c0315 (10.4k)             | 2/2              | 2/2 (0.6–0.8s) | 0/2           | 2/2 (3.2–5.3s)   |
| be5f2781 (15.4k)             | 0/2              | 2/2 (1.8–3.1s) | 1/2           | 2/2 (2.7–3.1s)   |
| e8f2279b (26.9k)             | 2/2              | 2/2 (1.0–1.2s) | 0/2           | 2/2 (4.1–4.4s)   |
| a890a362 (47.8k)             | 0/2              | 2/2 (2.4–2.8s) | 0/2           | 2/2 (12.9–14.9s) |
| a890a362 (47.8k, later turn) | 0/2              | 2/2 (2.6s)     | 0/2           | 2/2 (12.2–12.4s) |
| 3b5c2813 (95.7k)             | 0/2              | 2/2 (3.1–7.0s) | 0/2           | 2/2 (7.8–8.4s)   |
| Total                        | 11/20            | 20/20          | 5/20          | 19/20            |

"Old bounds" is prod's 1.2s Cerebras guard, 2s GLM guard, and 3s router
attempt (the code defaults were set to those values for that run). With
every provider up, they lost 9 of 20 turns, all at 7.9k tokens and above.
With 15s, every turn served on attempt 1 inside 7.0s. In glm-only, the one
attempt-1 miss (2929bc93: no GLM content inside 15s) was served by the
regenerate at 20.7s.

- Direct Cerebras first content, after its request: 0.3–0.7s on most
  contexts up to 10k tokens, 1.3–1.4s at 7.9k and 15.4k, 0.7–1.0s at
  26.9k, 1.5–1.9s at 47.8k, and 2.9s at 95.7k. In the other 95.7k run GLM decided at 7.0s
  before Cerebras sent content.
- GLM first content, after its request: 0.4–8.6s, not monotonic in
  context size (8.6s on a 1.7k-token context, 6.5s at 88k GLM tokens).
  Decision time does grow with context: 12.2–14.9s at 48k, the closest any
  run came to the 15s bound.
- Per-minute token limit: on the old bounds, the 95.7k context's Cerebras
  request was aborted at 1.2s and the regenerate's Cerebras request got
  HTTP 429 `Tokens per minute limit exceeded` at 3.0s. One such request is
  about 60% of the org's 150k tokens/minute, and an aborted request still
  counts.

The replay's per-run records are `/tmp/rca/longctx/replay-prod-bounds.jsonl`
and `replay-after-15s.jsonl` (plus `replay-before-5s.jsonl` for the first
fix, which served 16/20 and 15/20 on attempt 1).

**Eight seconds for direct Cerebras (2026-10-01).** Review then set direct
Cerebras's guard (connect, first content, SSE idle) to 8s from the start of
its request. The router attempt and the GLM failover keep 15s. The hedge
starts the OpenRouter fallbacks 800ms into the request, so when the 8s guard
ends Cerebras, they keep racing until the router attempt's bound.

The same harness replayed the 10 contexts above plus 10 more served prod
router turns (1.8k–7.8k tokens), twice each, on the 8s code (15:38–16:10Z).
A third scenario, "cerebras-only", stalls every OpenRouter route, so direct
Cerebras is the only path.

| Scenario      | Served on attempt 1 | Served at all | Apologies |
| ------------- | ------------------- | ------------- | --------- |
| prod          | 39/40               | 40/40         | 0         |
| glm-only      | 39/40               | 40/40         | 0         |
| cerebras-only | 39/40               | 40/40         | 0         |

- No direct-Cerebras request came near the 8s guard. First content after
  the request was at most 5,650ms (95.7k tokens; 5,585ms in cerebras-only),
  3.4s at 47.8k, and under 2.8s everywhere else. The same 95.7k context
  measured 2.9s on the 15s code, so time to first content there varies by
  about 2x between runs.
- None of the three regenerates involves the 8s guard:
  - prod, 95.7k context: Cerebras returned HTTP 429 `Tokens per minute
limit exceeded` at once. GLM's first content landed 14.1s into the
    turn, the attempt expired, and the regenerate served via GLM at 25.7s.
  - cerebras-only, 5.3k context: the same 429 with every other route
    stalled. The regenerate served at 15.7s.
  - glm-only, 3.9k context: no GLM decision inside 15s. The regenerate
    served at 23.9s.
- Both 429s came from the replay's own back-to-back long contexts on the
  org's 150k tokens/minute.
- Three glm-only runs closed at 15.0s on a decision recovered from the
  partial stream at the deadline. GLM-only on the 88k-token context decided
  at 14.0–15.0s, and at 10.7–14.9s on 47.8k.
- On the 10 contexts shared with the 15s run: 19/20 and 20/20 served on
  attempt 1 (prod, glm-only), against 20/20 and 19/20 on the 15s code. The
  single prod miss is the 429 above.

Per-run records: `/tmp/rca/longctx/replay-after-8s.jsonl`.

**Repro (local, watched fail then pass, prod bound defaults).**
`back-end/src/tests/blackbox/chat-router-failover.blackbox.ts` drives
`postMessage` on a seeded completed agent. Its chat-model projection is the
30-message router request; prod logged `messageCount=30`. Prod logs do not
record content, so the 88,440 chars come from projecting the stored
transcript with the same code (`chat-router-failover-prod-e8f2279b.json`;
PII including the delivery street replaced with same-length stand-ins). It
replays recorded provider streams with their real timing
(`chat-router-failover-prod-e8f2279b-streams.json`): the Cerebras stall,
healthy Cerebras, and the GLM failover.

- `origin/main`: case (a) fails with the apology after 3064ms, case (b)
  after 3031ms, and case (d) because the first stalled attempt never
  regenerates.
- Router fix only: (a) and (b) fail with the apology after about 10.05s; the
  GLM branch dies to its 2s guard on both attempts.
- Before the per-request session: (b) fails with
  `every GLM failover must name its own OpenRouter session`, because both
  attempts' GLM requests shared the conversation-derived pin.
- First fix (5s no-progress bound): `PASS chat-router-failover (4 cases)`.
- 15s fix: `PASS chat-router-failover (6 cases)`. With the 8s Cerebras
  guard: `PASS chat-router-failover (7 cases)`, the six below plus (g).
  - (g) Cerebras stalls and GLM's first content lands 8,583ms after its
    request, the slowest measured in the replay (9,383ms into the turn).
    The 8s guard ends Cerebras at 8,015ms with `Cerebras produced no model
output within 8000ms`, GLM keeps racing, and the turn escalates on
    router attempt 1 at 13.8s. On the 15s Cerebras guard, (g) fails its
    precondition, because GLM's first content would land inside the guard.
  - (a) escalates at 8.4–8.6s via `z-ai/glm-5.3-flash`. The reasoning
    cites the corrected address, and the re-plan goal anchors on it and not
    on the rejected Irving home.
  - (e) long-context GLM: the recorded GLM stream starts 3,466ms late, so
    its first content lands 7,339ms into the turn (6,539ms after its
    request, as measured live on the 88k-token context). It escalates at
    11.8s on router attempt 1.
  - (f) long-prefill Cerebras: the healthy Cerebras stream starts 2,151ms
    late, so its first content lands at 2,935ms, as measured live at 95.7k
    tokens. The hedge has started the (stalled) failover; Cerebras still
    serves at 3.1s with no regenerate.
  - (b) attempt 1 expires on the router's 15s bound (`kind=deadline`). The
    regenerate's GLM request carries a different `session_id` and escalates
    at 23.5s.
  - (c) healthy Cerebras escalates at 1.0–1.1s.
  - (d) an exhausted budget surfaces exactly one notice and leaves the agent
    ACTIVE.
- Prod's old bounds (1.2s Cerebras, 2s GLM, 3s router attempt) set as the
  code defaults on the final code: (a), (e), (f), and (b) all end in the
  apology at 6.0–6.2s; (c) and (d) pass.
- Live mode (`CHAT_ROUTER_FAILOVER_LIVE=1`): direct Cerebras and every other
  OpenRouter route are stalled, so the real GLM failover is the only path
  that can serve.
  - `origin/main`: apology after 3066ms. The 3s router bound is tighter than
    either GLM guard.
  - Bounds fixed, default routing: 3 of 3 escalated on router attempt 1, at
    4979ms, 11093ms, and 7412ms. A fourth run, pinned to InferenceNet, got
    the apology after 20,077ms over 2 attempts.
  - Throughput routing, before the per-request session: 5 of 5 escalated on
    router attempt 1, at 3254–3842ms, served by CoreWeave.
  - Final code, 35 samples over two sessions (07:06–07:11Z and
    08:02–08:09Z): 32 escalated on router attempt 1 (Parasail 18, BaseTen 6,
    CoreWeave 6, Modal 1, Friendli 1), 2 escalated on the regenerate, and 1
    apologized. Attempt-1 escalations landed at 2.7–9.8s, with first content
    0.6–3.7s after the GLM request.
    - 07:06:36Z: both attempts' GLM requests (5s apart) got no event within
      4.2s, and the turn apologized at 10.06s. Status was not recorded then.
    - 07:07:21Z: attempt 1 got no event within 4.2s, and the regenerate
      served via Parasail (first content 1221ms), so the user would have
      seen the escalation 8.16s into the turn.
    - 08:04:30Z: attempt 1 got no response headers in 4,196ms
      (`openrouter_fast_chat.end` with `end=caller_aborted`, no status), and
      the regenerate served via CoreWeave at 9.34s. The probe's re-probe 60s
      later served on attempt 1.
    - The misses are short and per-request, not an outage: a live run at
      07:07:06Z served between the first two, and four direct requests
      started about 07:07:32Z all served at 1.2–1.7s.
    - One further 08:07:52Z run is excluded: local Postgres stopped accepting
      connections before any provider request (see the runner leak below).
  - Final probe code (connect timing, then the goal-anchor check): 08:35Z,
    09:21Z, 09:33Z, and 09:39Z all escalated on router attempt 1, via
    CoreWeave, CoreWeave, BaseTen, and Friendli (connected in 46ms, 44ms,
    58ms, and 44ms). The 09:39Z run, on the final goal rule, had first
    content at 2,031ms and escalated at 4,686ms with a goal "near 88 Harlow
    St, … San Francisco".
  - 15s code, 14:33–14:35Z: 3 of 3 escalated on router attempt 1, at
    6,007ms (Together, first content 1,707ms after the GLM request),
    4,796ms (CoreWeave, 2,237ms), and 3,785ms (Together, 856ms), each with
    a goal near 88 Harlow St.
  - 15s code merged with `main` (`41a721495`), 15:09Z: escalated on router
    attempt 1 at 5,985ms (Together, first content 2,108ms after the GLM
    request) with a goal near 88 Harlow St. On the same snapshot, setting
    the three defaults back to 1.2s / 2s / 3s makes the offline exact-prod
    case end in the apology after 6,051ms.
  - 8s Cerebras guard (`102abb7bf`), 16:16Z: escalated on router attempt 1
    at 4,972ms (Together, first content 1,648ms after the GLM request) with
    a goal near 88 Harlow St.

**Cemented in `/deploy`.**

- Step 4a, backend coverage: auto-discovers the offline cases.
  - `chat-router-failover.blackbox.ts` (7 offline cases above, including
    the two long-context cases replayed at the first-content times measured
    on the 95.7k-token prod context, and GLM's slowest measured first
    content after the 8s Cerebras guard).
  - `openrouter-fast-chat.blackbox.ts`: throughput routing with
    `require_parameters`, no fixed host list, and a distinct session per
    request; the host is reported once; the `openrouter_fast_chat.end`
    record for an abort before headers, an abort after headers with no
    event, a served stream, and the route's own guard; and a caller abort
    stops the direct-Cerebras route with no further OpenRouter request and
    no `pre_content_failover_to_waterfall` log.
  - `chat-router-options.test.ts` pins the router attempt and GLM guard at
    `CHAT_TIMEOUT_MS = 15_000`, the direct-Cerebras guard at 8,000ms (inside
    the router attempt), and that progress does not extend the router
    deadline; `chat-router-stream`
    pins the 15s attempt bound and the 2-attempt budget;
    `hedged-stream.test.ts` pins branch-failure reporting.
  - `chat-router-failover-live-verdict.test.ts` pins the live probe's
    verdict on the recorded live shapes: served first, the 07:07:21Z shape
    (re-probe), two misses (fail), late first content (re-probe), and
    fail-at-once for HTTP 402, content without a decision, a wrong address,
    a goal that keeps the rejected anchor, a connect that never completed,
    events without a host, and a timeout. It also pins the goal-anchor check
    on twelve accepted goals (two recorded live, plus phrasings such as
    "within 2 miles from", "not too far from", "near the 88 Harlow St
    address", and a recap of the earlier Irving search) and eleven rejected
    ones, including "near Irving, TX
    75063; do not anchor on 88 Harlow St" and goals that echo the context's
    own sentences about the delivery address.
- Step 4p, `scripts/run_deploy_live_probes.py`: runs the live probe as
  `chat-router-failover-live`, after `amplitude-live` because both boot the
  runner's db push and trigger hooks.
  - It first checks that the OpenRouter key it will use is the one
    `back-end/.env` configures (account settings decide which GLM hosts a
    request may reach) and prints its fingerprint.
  - It sends the exact e8f2279b follow-up with direct Cerebras and every
    other OpenRouter route stalled, so only the real GLM failover can serve.
  - It passes when the turn escalates on router attempt 1 with no error
    alert and the re-plan goal anchors on the corrected address (`88 Harlow`,
    the fixture's same-length stand-in for the user's street) and not on the
    rejected Irving home. Mentioning the address is not enough: the replayed
    context still says "Do NOT anchor on 88 Harlow St" and names the Irving
    home. So in the goal's first sentence, which states what the run does,
    the first mention of either place that is not negated must be the
    corrected address. Later recaps of the earlier search do not count.
  - An OpenRouter-side miss (the connection opened but no response headers
    came, or HTTP 200 with no first content inside the 14.2s budget) is
    re-probed once, 60s later. A connect that never completed is not one. A
    second miss, or any other failure, blocks the deploy.
  - It prints the serving host and its connect, header, first-event, and
    first-content times for every attempt.
- What the probe does not cover: this scenario escalates, so the speculative
  generator is discarded and the router is the only serving path. The probe
  does not cover direct-answer turns that the generator serves during a
  Cerebras stall (see residual risks).

**10k agents.** No shared state, lock, or channel is added on our side; all
cost is per turn on the agent being served. During a Cerebras-wide stall,
each turn holds:

- Two direct-Cerebras streams (router and speculative generator) for up to
  8s each, previously 1.2s. On a stall they hold a connection, not tokens;
  on a long prefill they now finish instead of being aborted and re-sent.
- Up to four OpenRouter streams (Qwen spill and GLM, for router and
  generator) for up to 15s per router attempt, previously 3s, with at most
  one extra router attempt.

The regenerate re-sends the 24k-token prompt and tries Cerebras first again,
so prompt tokens roughly double on a miss.

The fan-in is concentrated. `sort` disables OpenRouter's load balancing, so
every failover request goes to the current throughput leader (Parasail
served 46 of 62 profile requests). That host takes all failover traffic
until it errors, and then OpenRouter moves the request to the next host
(`allow_fallbacks` stays on). A leader that slows down without erroring
keeps the traffic until OpenRouter's rolling throughput ranking changes. The
leader moved from CoreWeave to Parasail within an hour. BaseTen already
returned 429s when pinned. The other shared point is our OpenRouter account
rate limit. Failover streams are held longer (up to 15s per attempt instead
of 3s), and a regenerate sends a second round of Cerebras, Qwen-spill, and
GLM requests, so both stream-seconds and request count rise during a
Cerebras stall.

The leaders list $0.15/M prompt against $0.05/M for InferenceNet. An
uncached 24k-token failover call costs about $0.004 instead of $0.0015, and
only while Cerebras stalls. Fresh sessions also give up the host affinity
that lets a repeat turn read the prompt cache ($0.03/M on Parasail).

**Residual risks, not fixed here.**

- Short OpenRouter misses, accepted at the measured rate (needs approval).
  Under the first fix's 4.2s budget, 4 of 38 live router GLM requests got no
  first content in time. Direct throughput-sorted requests missed 1 of 86 (0
  of the 62 profiled above, 1 of 24 sent each from a fresh process). Per
  turn: 1 apology and 2 regenerate escalations (8.2s and 9.3s) in 35 live
  samples. Under the 14.2s budget, 1 of 20 glm-only replays on real prod
  contexts (7.9k tokens) got no GLM content inside 15s, and its regenerate
  served at 20.7s.
- Direct Cerebras on the longest contexts. Its first content reached 5.65s
  at 95.7k tokens, against the 8s guard. A longer context, or a slower
  Cerebras minute, could cross 8s; the guard then ends Cerebras and the turn
  depends on GLM inside the router's 15s, which is the next risk.
- Long contexts during a Cerebras outage sit close to the bound. GLM-only
  decisions on the 47.8k-token context closed at 10.7–14.9s, and at
  14.0–15.0s on the 88k-token one. A slower host
  there costs a regenerate (up to 30s to the answer) or, if both attempts
  miss, the apology. With Cerebras up, the same context served in 2.4–2.8s.
  - The shape is decided after the request leaves. In the fresh-process
    miss, connect finished at 64ms and the request was sent at 64ms, but
    OpenRouter's headers arrived at 4,627ms (BaseTen; first content
    5,031ms). OpenRouter often holds headers until the host streams its
    first event (10 of 24 within 2ms), so "no headers" means no host
    started within the budget.
  - Which host was trying is unknown for every miss, because no event
    arrived. The regenerate's request is routed by the same `sort`, so a
    window covering both attempts (07:06:36Z) still apologizes.
  - Prod cannot yet say which host failed, but every miss is now recorded:
    prod logs `openrouter_fast_chat.end` per GLM request, and the deploy
    probe prints connect, header, first-event, and first-content times per
    attempt.
  - Not done here, because both change bounds or routing: a third router
    attempt, or routing attempt 2 away from attempt 1's host.
- The generator path. Neither the speculative nor the canonical generator
  has a completion deadline, and the Qwen spill branch has no pre-token
  guard (only the 60s SSE idle default). On a direct-answer turn during a
  Cerebras stall where GLM also fails, the race waits on the spill for up to
  about 60s before the generic waterfall. This scenario escalates, so it
  does not take that path.
- `NON_DIRECT_INTENT` in `earlyDirectGenerator.ts` (from `e6681061c`) is a
  keyword regex that decides whether to start the speculative generator. It
  predates this case and is a load-shedding hint, not the routing decision,
  but it is the string-matching pattern the harness rules forbid. Removing it
  changes speculative load on every turn, so it is proposed for approval
  rather than changed here.

**Deeper cause, not fixed (needs schema/prompt approval).** GLM's 1447-char
decision spends 660 chars on `query`, which the schema says should be an
empty string for this action. `goal` is emitted after `query`, and partial
recovery needs a complete `goal`, so the unused field sits on the critical
path: about 2s on the slow hosts and well under 1s on the throughput-sorted
ones. Reordering the fields or enforcing an empty `query` would shorten
every failover decision.

**Known consequence.** `front-end/tests-e2e/chat-lifecycle-latency.spec.ts`
(5s ratchet) runs in every `/deploy` (semantic stage, alone on one worker)
and in the prod `chat-lifecycle-ratchet.yml` workflow. It measures the
healthy path. While Cerebras is stalled, it now measures the real failover
(2.7–9.8s to an attempt-1 escalation in the live probe), and it fails
honestly when a
turn lands on a slow host or regenerates. Previously the keyword fallback
masked that.

**Environment footgun.** The Cloud VM injects
`OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS=20000`, which is not in any repo file
and not on Render. It must be removed from the Cursor Cloud Agents secrets,
or any test that does not strip it proves a configuration prod does not run.

**Test-runner leak found while verifying.** `run-blackbox-tests.sh`
backgrounded `npx tsx src/bootstrap.ts`, and cleanup sent SIGTERM to `$!`,
which is npx. npx exits without forwarding the signal, so tsx and the server
were reparented to PID 1 after every run. Fifty-four leaked backends (about
300MB each) left 275MB free on the 16GB VM, and local Postgres stopped
accepting the 08:07:52Z probe's connection.

- Cleanup now stops the backend's whole descendant tree (TERM, then KILL
  after 5s), and the trap is installed before the backend starts.
- The backend stays in the runner's process group, so the group signal from
  `run_deploy_live_probes.py` still reaches it.
- `blackbox-backend-process-tree.test.ts` (Step 4a) fails on the old
  `kill $!` with tsx and its node child surviving, and passes on the fix.
- The real runner left no backend after a normal exit, a group SIGTERM, or a
  group SIGKILL.
- The same class in the `run-port-collision` structural gate: it killed the
  subshell around each `http.server` fixture, so three listeners outlived
  every run (eight had piled up on the VM). The fixtures now `exec` the
  server, and the gate fails if a killed fixture's port still accepts
  connections. It failed that check before the change and passes after,
  with no listener left behind.

## Related open latency observation (2026-10-02)

The earlier cardinality/FAILED defect remains the fixed case above. A later
semantic gate on source `bc1806459838b8bc7e31282f3fc637f5e2106577`
failed direct-answer sample 4 at the existing 3-second router deadline.
Nineteen of 20 measured samples stayed below the unchanged 5-second lifecycle
bound; this sample missed its canonical route and answer milestones at
15 seconds. The complete gate exited 1 after 603.920 seconds with source
unchanged and its outer wall guard unexceeded. This is infrastructure failure,
not a successful answer or a genuine task failure.

Correlated requests at 03:44:55 UTC show both direct Cerebras calls returning
HTTP 429 after approximately 140 ms. The router's same-model OpenRouter
fallback starts immediately; its fast GLM hedge starts another 501 ms later.
The generator finishes a valid answer at approximately 1.55 seconds. The
router has no logged first chunk before its deadline; the handler records a
deadline miss and persists the failure notice. Its final dump contains valid
`direct_answer` JSON, but records consumer closure and no finish reason.
The dump was finalized approximately 100 ms after the deadline. That timestamp
is not a raw network arrival timestamp and provides no in-budget success.

Archive searches for `chat lifecycle latency direct_answer 15000 first-response`
and `chat fallback provider stream route completion timeout semantic` found
this quota-to-router-deadline case and
`2026-07-21-serial-fallback-after-cerebras-stall-left-latency-unbounded`.
They identify related boundaries, not proof of an identical root cause.
Original SSE arrival timings, the selected OpenRouter provider endpoint and
generation identifier were not captured. The exact latency cause remains
open. Incoming main `be9aa53d` changes fallback order and host preference;
it has not been shown to resolve this original failure.

Preserve this live gate as the actual RED. No additional standalone model
calls or source fix were made for this observation. After source adoption,
required canonical backend coverage must cover the existing provider-route,
quota-fallback, hedge and router-boundary controls, followed by the unchanged
`chat-lifecycle-latency` semantic gate (four paths, five measured samples each).
Keep the 3/5/15-second bounds and existing assertions unchanged. A later GREEN
validates the adopted source; it does not establish the missing original
provider cause. The evidence and archive-search hashes are retained privately
under `.context/acceptance/proof103-semantic-latency-rca/`.

## Test-clock recurrence (2026-10-02)

The required backend coverage run on `a16c34d8` failed the slow GLM
failover case after its router stream completed in 13,896 ms, inside the
unchanged 15-second router bound. Postdecision message/tool persistence then
took about 6,934 ms before Temporal acceptance. The test compared that later
whole-turn observation with the router bound. The first bad boundary was the
test assertion, not evidence that the router exceeded its deadline. The cause
of the original persistence delay remains open.

Archive searches used `chat-router-failover; GLM guard; first attempt bound`
and `router clock/deadline; timing assertion; scheduler fixture`; this case
owns the regression. The related scheduler-window fixture case from 2026-08-03 informed
boundary selection, without establishing the cause of the database delay.

The existing seven-case offline blackbox now observes the real RouterLLM
start/completion log pair for the exact fixture agent and stream. This measures
the whole stream, which contains the successful attempt, rather than nominal
recorded chunk offsets. Both affected failover cases require a measured stream
below 15 seconds and actual durable turn completion below 40 seconds. Existing
single-attempt, escalation, provider cancellation and goal assertions remain.
Only the slowest case holds its own postdecision assistant-message write until
after the already completed stream's 15-second boundary. It still performs the
real database write and Temporal acceptance. The observer forwards stdout
unchanged, drains its owned write and restores patched methods in `finally`.
Missing or duplicate measurements fail closed.

With canonical fixture exports, the full seven-case RED ran in 68.767 seconds:
six passed, and only the wrong-clock assertion failed. Its measured stream took
13,872 ms while the whole case took 15,302 ms, including setup and cleanup.
Changing only the two
comparison operands produced seven passes in 67.836 seconds; the controlled
case retained a 13,832 ms stream, a 15,171 ms escalation observation and a
15,316 ms whole-case duration. The actual durable turn stayed below its separate
40-second assertion. The control
helper, driver, environment, recorded streams, limits and other assertions were
identical. The test implementation file necessarily has different RED/GREEN
hashes because its assertion is the repaired implementation.

Earlier pressured replays exceeded the real stream bound and remain failures.
A separate seven-case attempt reproduced the clock bug but also omitted the
canonical fake alert exports; it remains a mixed failure, not part of the
identical-environment pair. All original aggregate failures are preserved.
Exact native owners were absent after the final pair and all 21 observed
fixture agents from the last three runs had zero remaining agent, message and
tool-usage rows. This is test-boundary proof, not live model acceptance credit.
The existing `chat-router-failover` domain remains auto-discovered by the normal
backend blackbox gate in `/deploy`; no suite or deadline was added.
Independent review and final static checks are recorded with the private
source-bound evidence under `.context/acceptance/proof113-chat-router-clock-rca/`.

## Progress-fixture scheduling recurrence (2026-10-06)

Backend coverage at `85070617` failed `chat-router-options` because its
ten-millisecond interval produced too few chunks within a 150-millisecond
fixture deadline. The assertion failed before testing whether progress could
extend the attempt deadline. A controlled 170-millisecond event-loop delay
reproduced that exact precondition failure; no provider request was involved.
Archive searches covered the literal stream-progress precondition, router timer
scheduling and native observer delays. This is another test-clock boundary in
the same owner, not evidence of a changed production router deadline.

The existing unit case now advances Node's actual timer APIs only after each
observed chunk. It requires fourteen completed progress steps, permits progress
at 149 milliseconds and requires expiration at the original 150 milliseconds.
The identical delayed-event-loop command passes, as does ordinary execution.
No production code, request budget, prompt, model or evaluator changed. The test
remains recursively discovered by the normal backend unit and coverage runners;
no new suite or paid verification was added. Original coverage failure and paired
source-bound receipts remain private under the deploy RCA workspace.

Standing user feedback requires robust, compact deploy regressions and rejects
host-scheduling assumptions as independent runtime acceptance gates.

## Live failover verification recurrence (2026-10-14)

During WhatsApp media deployment, the unchanged `CHAT_ROUTER_FAILOVER_LIVE=1`
owning gate failed two samples sixty seconds apart. All four attempts used the
same captured thirty-message request (normalized SHA256 prefix
`3a15756f1b54ff8b`), with unchanged strict schema, temperature zero, maximum
1024 output tokens, and minimal reasoning. Three attempts received HTTP 200
after approximately ten seconds but produced no SSE event/content before the
existing precontent deadline. The other attempt served through Together in
946 milliseconds, but was router attempt two and therefore did not satisfy
the required first-attempt outcome. The second sample ended in the existing
apology after 30,066 milliseconds.

Evidence: local run `1792016047-246840-7197`, agent IDs
`ebc333e8-ae2e-443b-9ef4-de53534f3c3b` and
`bef37f23-ef4e-4449-a1ae-68c60784d4cc`. The exact local LLM dumps, owning
runner log and backend transport spans were retained. The stalled attempts
did not reveal a provider host; Together is supported only for the successful
second attempt. Do not assign the three stalls to it.

Official OpenRouter status reported no unresolved incident. Its earlier
October 14 Pacific Northwest incident ended at 04:54 UTC, roughly eighteen
hours before this gate, and does not explain these samples. Current official
model/routing documentation supports the model and request parameters. The
runtime evidence establishes a precontent delivery stall, not a newly proven
owned parser, prompt, timeout-policy or decision defect. No production code,
prompt, provider selection, assertion or deadline was changed. This preserves
the earlier owned fix while recording a red live acceptance result.

The deployment remains unqualified pending an unchanged focused retry, due at
22:24:07 UTC from the 22:14:07 UTC attempt start. Preserve each failed attempt
and its clocks; do not relabel it as a pass or substitute an offline proxy.

The unchanged retry started at 22:24:28 UTC and passed: local run
`1792016668-349995-14987`, first-attempt provider Parasail, HTTP 200 at 1,201
milliseconds, first content at 1,380 milliseconds, and durable escalation at
4,063 milliseconds. The owning case passed in 4,302 milliseconds (full domain
5,149 milliseconds). The failed samples remain failures; only this later live
attempt satisfies the gate. No code or request/acceptance criteria changed.
