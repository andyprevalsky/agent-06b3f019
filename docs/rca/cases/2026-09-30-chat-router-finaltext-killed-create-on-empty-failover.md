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
  - 'Chat handler error: Expected one structured output item, received 0'
  - 'cerebras_chat.pre_content_failover_to_waterfall'
  - "Sorry — I couldn't generate a response just now. Please try again."
  - '[ChatStructuredRetry] Deadline miss is not regenerated'
  - 'Chat handler error: Chat router completion expired'
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

The 3s per-attempt completion bound is unchanged (superseded 2026-10-01: a
5s no-progress stall bound plus a 15s per-attempt cap). First-turn
speculation load-shed is unchanged.

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

## Reusable lesson

Regenerate a transient empty, unparseable, or deadline-expired structured LLM stream in place, and size each per-attempt bound from the measured latency of the slowest path allowed to serve (the failover) under the provider routing prod actually gets, never from the healthy primary.

Do not fail the agent, do not substitute a keyword shortcut for the model's
decision, and do not apologize until the bounded regenerate budget is
exhausted.

## Recurrence — 2026-10-01 (agent e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6)

**Symptom.** An agent had completed a hot-yoga run in Irving, TX. The user's
follow-up "wrong address, its the 88 howard one" got `Sorry — I couldn't
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
   howard one" does not match, so it apologized. That string-matching
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
nothing from the failover until its first content. The router's 5s stall
bound therefore gives the failover 5.0 − 0.8 = 4.2s from its own request to
first content. Reasoning re-arms the stall bound only after that. The 5s GLM
guard starts with the GLM request, 0.8s into the turn, so on the router path
it never cuts before the router's own bound. It binds only for the
speculative generator, which has no router bound.

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

- `routerCompletionDeadline.ts`: the per-attempt bound is now two timers.
  - A no-progress stall timer (5s), re-armed by every reasoning or content
    delta the router receives. Reasoning counts because the router streams it
    to the user as the thinking row. Before a hedge branch serves, nothing
    reaches the router (see the pre-content budget).
  - A hard completion cap (15s).

  `CHAT_ROUTER_STALL_TIMEOUT_MS` and `CHAT_ROUTER_COMPLETION_TIMEOUT_MS`
  override them, and the stall bound is clamped to the cap.

- `chatStructuredRetry.ts`: deadline misses regenerate again under the same
  2-attempt budget as empty and parse misses.
- Deleted `deadlineRouterFallback` and `EXPLICIT_AGENT_INTENT`, plus their
  `chatHandler.ts` wiring. Deleting them is better than guarding them.
- `openrouterFastRoute.ts`:
  - The GLM guard (pre-token, connect, and SSE idle) goes from 2s to 5s. A
    unit test pins that it is no tighter than the router's stall bound, so
    it never cuts before the router.
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
  stall bound), a failed hedge rethrows instead of falling through to the
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
- Full fix: `PASS chat-router-failover (4 cases)`.
  - (a) escalates at 8.4–8.6s via `z-ai/glm-5.3-flash`, and the reasoning
    cites the corrected address.
  - (b) attempt 1 expires on the router's 5s stall bound (`kind=deadline`).
    The regenerate's GLM request carries a different `session_id` and
    escalates.
  - (c) healthy Cerebras escalates at 1.0–1.1s.
  - (d) an exhausted budget surfaces exactly one notice and leaves the agent
    ACTIVE.
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

**Cemented in `/deploy`.**

- Step 4a, backend coverage: auto-discovers the offline cases.
  - `chat-router-failover.blackbox.ts` (4 offline cases above).
  - `openrouter-fast-chat.blackbox.ts`: throughput routing with
    `require_parameters`, no fixed host list, and a distinct session per
    request; the host is reported once; the `openrouter_fast_chat.end`
    record for an abort before headers, an abort after headers with no
    event, a served stream, and the route's own guard; and a caller abort
    stops the direct-Cerebras route with no further OpenRouter request and
    no `pre_content_failover_to_waterfall` log.
  - `chat-router-options.test.ts` pins the bounds and the GLM-guard
    invariant; `hedged-stream.test.ts` pins branch-failure reporting.
  - `chat-router-failover-live-verdict.test.ts` pins the live probe's
    verdict on the recorded live shapes: served first, the 07:07:21Z shape
    (re-probe), two misses (fail), late first content (re-probe), and
    fail-at-once for HTTP 402, content without a decision, a wrong address,
    events without a host, and a timeout.
- Step 4p, `scripts/run_deploy_live_probes.py`: runs the live probe as
  `chat-router-failover-live`, after `amplitude-live` because both boot the
  runner's db push and trigger hooks.
  - It first checks that the OpenRouter key it will use is the one
    `back-end/.env` configures (account settings decide which GLM hosts a
    request may reach) and prints its fingerprint.
  - It sends the exact e8f2279b follow-up with direct Cerebras and every
    other OpenRouter route stalled, so only the real GLM failover can serve.
  - It passes when the turn escalates on router attempt 1 with no error
    alert and the re-plan goal carries the corrected address (`88 Harlow`,
    the fixture's same-length stand-in for the user's street).
  - An OpenRouter-side miss (no response headers, or HTTP 200 with no
    first content inside the 4.2s budget) is re-probed once, 60s later. A
    second miss, or any other failure, blocks the deploy.
  - It prints the serving host and its header, first-event, and
    first-content times for every attempt.
- What the probe does not cover: this scenario escalates, so the speculative
  generator is discarded and the router is the only serving path. The probe
  does not cover direct-answer turns that the generator serves during a
  Cerebras stall (see residual risks).

**10k agents.** No shared state, lock, or channel is added on our side; all
cost is per turn on the agent being served. During a Cerebras-wide stall,
each turn holds:

- Two direct-Cerebras streams (router and speculative generator) until their
  1.2s guards fire.
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
  4 of 38 live router GLM requests got no first content inside the 4.2s
  budget. Direct throughput-sorted requests missed 1 of 86 (0 of the 62
  profiled above, 1 of 24 sent each from a fresh process). Per turn: 1
  apology and 2 regenerate escalations (8.2s
  and 9.3s) in 35 live samples.
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
