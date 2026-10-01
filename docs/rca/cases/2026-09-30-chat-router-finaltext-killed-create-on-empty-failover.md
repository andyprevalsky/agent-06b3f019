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
3. `chat-router-stream.blackbox.ts` asserted source text (the
   `kind === 'deadline'` carve-out and the fallback's presence). It never
   checked an outcome on a real failover stream, so it locked the regression
   in.

**Evidence.**

- Live Cerebras, exact prod router context (30 messages / 88,440 chars):
  3 of 15 calls returned HTTP 200, a role-only delta at about 417ms, then
  silence. This is the stall that the 1.2s pre-content guard hands to the
  hedge.
- Failover latency profile, n=24, exact context, Cerebras stalled, real
  OpenRouter:
  - First content: p50 1.7s, p90 3.9s, max 8.55s.
  - Completion: 4.1–19.1s (p50 5.8s, p90 10.9s). 0 of 24 completed within 3s.
  - Max inter-chunk gap: about 416ms.
  - Winners: GLM 23, Qwen 1. All 24 chose `start_superintelligence`.

  The 3s whole-completion bound therefore killed every failover attempt.

- Replaying that profile against the new policy (5s no-progress stall plus a
  15s per-attempt cap) serves 22 of 24 on the first attempt. The other two
  regenerate.

**Fix (PR #1348).**

- `routerCompletionDeadline.ts`: the per-attempt bound is now two timers.
  - A no-progress stall timer (5s), re-armed by every reasoning or content
    delta.
  - A hard completion cap (15s).

  `CHAT_ROUTER_STALL_TIMEOUT_MS` and `CHAT_ROUTER_COMPLETION_TIMEOUT_MS`
  override them, and the stall bound is clamped to the cap.

- `chatStructuredRetry.ts`: deadline misses regenerate again under the same
  2-attempt budget as empty and parse misses.
- Deleted `deadlineRouterFallback` and `EXPLICIT_AGENT_INTENT`, plus their
  `chatHandler.ts` wiring. Deleting them is better than guarding them.
- The healthy Cerebras path never reaches either bound and is unchanged. The
  worst case before the apology is 2 × 15s = 30s (previously 3s).

**Repro (local, watched fail then pass).**
`back-end/src/tests/blackbox/chat-router-failover.blackbox.ts` drives
`postMessage` on a seeded completed agent. The agent carries the exact prod
router context, from the PII-scrubbed fixture
`chat-router-failover-prod-e8f2279b.json`. The test replays recorded provider
streams with their real inter-chunk timing, from
`chat-router-failover-prod-e8f2279b-streams.json`: the live Cerebras stall,
healthy Cerebras, and the GLM failover.

- Pre-fix:
  - `FAIL exact prod follow-up escalates through the recorded GLM failover`
    (got the apology after 3064ms).
  - `FAIL a fully stalled first router attempt regenerates` (got the apology
    after 3031ms).
  - `FAIL exhausted router budget surfaces exactly one notice` (the first
    stalled attempt must regenerate before the notice).
  - The healthy case passed.
- Post-fix: `PASS chat-router-failover (4 cases)`. The exact follow-up
  escalated at 8399ms via `z-ai/glm-5.3-flash`. The reasoning cites 88
  Howard, and the `cloud_agent` row and Temporal workflow both exist.
- Live mode (`CHAT_ROUTER_FAILOVER_LIVE=1`): Cerebras is stalled in-process
  and OpenRouter is real.
  - Pre-fix: apology after 3066ms.
  - Post-fix: 3 of 3 escalated in 6.3–6.9s, and in 8.06s through the
    canonical blackbox runner.

**Cemented in `/deploy`.**

- Step 4a, backend coverage: auto-discovers the offline cases.
- Step 4p, `scripts/run_deploy_live_probes.py`: runs the live probe as
  `chat-router-failover-live`, after `amplitude-live` because both boot the
  runner's db push and trigger hooks. `/deploy` fails if the real failover
  can no longer finish inside the router bounds on this exact context.
- `chat-router-stream.blackbox.ts`: the string assertions now check the
  profiled bounds and the regenerate budget, and that the keyword fallback is
  absent.

**10k agents.** One extra timer per in-flight router call, and at most one
extra router attempt per turn on that agent. There is no shared state or
fan-in.

**Known consequence.** `front-end/tests-e2e/chat-lifecycle-latency.spec.ts`
(5s ratchet) measures the healthy path. While Cerebras is stalled it will now
fail honestly, at about 6–9s. Previously the keyword fallback masked that.
