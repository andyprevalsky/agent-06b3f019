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

Regenerate a transient empty, unparseable, or deadline-expired structured LLM stream in place, and size each per-attempt bound from the measured latency of the slowest path allowed to serve (the failover), never from the healthy primary.

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
  a post-completion follow-up, ruled out. This context was 88,440 chars and
  both providers returned HTTP 200, so there was no window overflow.
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

**Second rung, one layer down.** GLM (`z-ai/glm-5.3-flash`, the
`openrouter-fast-chat` branch) is what serves a Cerebras stall. It has its
own 2s pre-token guard, which counts only content or tool-call chunks. That
guard was sized in `5c90a29ea` for a Flash-Lite model. `8f3c22f31` swapped
in GLM on the strength of a generic 0.48s TTFT figure and kept the 2s
guard. On this 24k-token context, GLM's first content came this long after
its request:

- 0.5–1.7s in 19 of 23 runs.
- 2.0–3.1s in 3 runs.
- 7.7s in 1 run.

The recorded failover (provider Together) sends its first event 2.92s after
the request. Prod could not show this rung: `hedgeStreams` swallowed
pre-latch branch failures. Locally, on prod defaults with the router fix
alone, the log reads `branch=openrouter-fast-chat ... OpenRouter fast chat
produced no model output within 2000ms` and the exact follow-up apologizes
at about 10s.

**Evidence.**

- Prod proves direct Cerebras produced no content within 1.2s and did not
  429: the primary error at 03:46:47.233Z is `RoseStallError`. Locally on the
  exact context, the stall shape (HTTP 200, a role-only delta at about 417ms,
  then silence) appears in 1 of the 8 saved direct-Cerebras probes
  (`profile_results.json`).
- Failover profile, n=24, exact context, Cerebras stalled, real OpenRouter,
  timed from the turn start:
  - First content: p50 1.8s, p90 3.8s, max 8.6s.
  - Completion: 4.1–19.1s (p50 6.0s, p90 10.7s). 0 of 24 completed within 3s.
  - Max inter-chunk gap: about 0.4s.
  - Winners: GLM 23, Qwen 1. All 24 chose `start_superintelligence`.
- Re-scored on prod config (attempt 1 only):
  - Old policy (3s bound, 2s GLM guard): 0 of 24 served.
  - Router fix alone (5s stall, 15s cap): 19 of 24.
  - Router fix plus a 5s GLM guard: 22 of 24.

  With one regenerate, the per-turn miss rate is roughly 1%.
- Evidence integrity: the first post-fix runs inherited
  `OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS=20000` from the Cloud VM environment
  (Render does not set it), so they proved a 20s GLM guard that prod never
  runs. The Step 7 adversarial review caught it. The test now removes every
  inherited chat-path bound override before it runs.

**Fix (PR #1348).**

- `routerCompletionDeadline.ts`: the per-attempt bound is now two timers.
  - A no-progress stall timer (5s), re-armed by every reasoning or content
    delta. Reasoning counts because the router streams it to the user as the
    thinking row.
  - A hard completion cap (15s).

  `CHAT_ROUTER_STALL_TIMEOUT_MS` and `CHAT_ROUTER_COMPLETION_TIMEOUT_MS`
  override them, and the stall bound is clamped to the cap.

- `chatStructuredRetry.ts`: deadline misses regenerate again under the same
  2-attempt budget as empty and parse misses.
- Deleted `deadlineRouterFallback` and `EXPLICIT_AGENT_INTENT`, plus their
  `chatHandler.ts` wiring. Deleting them is better than guarding them.
- `openrouterFastRoute.ts`: the GLM guard (pre-token, connect, and SSE idle)
  goes from 2s to 5s. A unit test pins the invariant that it is no tighter
  than the router's own no-progress bound.
- `hedgedStream.ts`: added `onBranchFailure`. Both chat races now log
  `cerebras_chat.hedge_branch_failed` (race, branch, error) unless the
  caller aborted. The Qwen spill branch is renamed from `openrouter-glm` to
  `openrouter-cerebras-spill`.
- The healthy Cerebras path never arms the hedge and is unchanged. The worst
  case before the apology is 2 × 15s = 30s (previously 3s).

**Repro (local, watched fail then pass, prod bound defaults).**
`back-end/src/tests/blackbox/chat-router-failover.blackbox.ts` drives
`postMessage` on a seeded completed agent whose chat-model projection is the
exact 30-message, 88,440-char prod router request
(`chat-router-failover-prod-e8f2279b.json`; PII including the delivery
street replaced with same-length stand-ins). It replays recorded provider
streams with their real timing (`chat-router-failover-prod-e8f2279b-streams.json`):
the Cerebras stall, healthy Cerebras, and the GLM failover.

- `origin/main`: case (a) fails with the apology after 3064ms, case (b) after
  3031ms, and case (d) because the first stalled attempt never regenerates.
- Router fix only: (a) and (b) fail with the apology after about 10.05s; the
  GLM branch dies to its 2s guard on both attempts.
- Full fix: `PASS chat-router-failover (4 cases)`.
  - (a) escalates at 8404ms via `z-ai/glm-5.3-flash`, and the reasoning cites
    the corrected address.
  - (b) regenerates after GLM hits the 5s guard on attempt 1.
  - (c) healthy Cerebras escalates at about 1.0s.
- Live mode (`CHAT_ROUTER_FAILOVER_LIVE=1`): direct Cerebras and every other
  OpenRouter route are stalled, so the real GLM failover is the only path
  that can serve.
  - `origin/main`: apology after 3066ms. The 3s router bound is tighter than
    either GLM guard.
  - Full fix, through the canonical runner: 3 of 3 escalated on router
    attempt 1, at 4979ms, 11093ms, and 7412ms.

**Cemented in `/deploy`.**

- Step 4a, backend coverage: auto-discovers the offline cases.
- Step 4p, `scripts/run_deploy_live_probes.py`: runs the live probe as
  `chat-router-failover-live`, after `amplitude-live` because both boot the
  runner's db push and trigger hooks. `/deploy` fails if real GLM can no
  longer serve this exact context inside the bounds.
- `chat-router-options.test.ts` pins the bounds and the GLM-guard invariant.
  `hedged-stream.test.ts` pins branch-failure reporting.

**10k agents.** No shared state, lock, or channel is added; all cost is per
turn on the agent being served. During a Cerebras-wide stall each turn holds:

- Two direct-Cerebras streams (router and speculative generator) until their
  1.2s guards fire.
- Up to four OpenRouter streams (Qwen spill and GLM, for router and
  generator) for up to 15s per router attempt, previously 3s, with at most
  one extra router attempt.

The regenerate re-sends the 24k-token prompt and re-tries Cerebras first.
There is no stall stickiness, so prompt tokens roughly double on a miss. The
shared fan-in point is the OpenRouter account rate limit, which this raises
in stream-seconds, not in request count.

**Deeper cause, not fixed (needs schema/prompt approval).** GLM's 1447-char
decision spends 660 chars on `query`, which the schema says should be an
empty string for this action. `goal` is emitted after `query`, and partial
recovery needs a complete `goal`, so the unused field sits on the critical
path: about 2s at the measured rate. Reordering the fields or enforcing an
empty `query` could bring the failover under the 5s lifecycle ratchet.

**Known consequence.** `front-end/tests-e2e/chat-lifecycle-latency.spec.ts`
(5s ratchet) measures the healthy path. While Cerebras is stalled it will now
fail honestly, at about 5–11s. Previously the keyword fallback masked that.

**Environment footgun.** The Cloud VM injects
`OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS=20000`, which is not in any repo file
and not on Render. It must be removed from the Cursor Cloud Agents secrets,
or any test that does not strip it proves a configuration prod does not run.
