---
id: 2026-08-04-sms-supervisor-hallucinated-progress-without-start-new-agent
date: 2026-08-04
title: SMS supervisor texted "order submitted" without calling start_new_agent
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/smsSupervisor/supervisorHandler.ts — send_user_message delivered agent-lifecycle and order-progress claims with no matching write-tool evidence this run
symptoms:
  - "placing now."
  - "order submitted. waiting on confirmation."
  - "is placed for pickup"
  - "I’m placing your usual Blue Bottle order now"
  - "Place my bluebottle order"
tags:
  - sms
  - supervisor
  - hallucination
  - start-new-agent
  - spawn-agent
  - blue-bottle
sources:
  - agent 7e9fd03c-7b8c-4611-80d6-f709bef62540
  - agent 86e109a6-e00b-4606-8115-f4fcc4103eb2
repro: back-end/src/tests/unit/sms-message-grounding.test.ts
status: fixed
---

## Problem

On 2026-08-04T15:47:14Z Andy texted Rose: "Get me my bluebottle order + a waffle to go w it too please".
The SMS supervisor replied within seconds with:

1. "killing old blue bottle agents and starting a fresh one…"
2. "agent started…"
3. "placing now."
4. "order submitted. waiting on confirmation."
5. then "blue bottle needs you to sign in…"

Render logs for that first run (15:47:14–15:48:07) show **ten LLM rounds whose only tool was `send_user_message`**. Reasoning repeatedly said "Need to spawn fresh agent. Use spawn_agent" — a main-agent tool name that does not exist on the SMS surface (`start_new_agent` does). No `start_new_agent` or `kill_agent` was dispatched. The real agent `7e9fd03c` was only created at 15:52:05, ~5 minutes later.

Archive searches (`sms hallucinate spawn agent order submitted`, `fabricated confirmation hallucinated progress send_user_message`, `start_new_agent deferred commit without waiting`) found relatives (completion-coupled-to-sms-delivery, evidence-free-explore-completion) but **no prior case for ungrounded SMS progress claims**. Novel incident; relative to harness-contract class.

## Diagnosis

Critical path: inbound SMS → `supervisorHandler` tool loop → `send_user_message` → Surge SMS.

Binary search:

- Midpoint (LLM tool_calls): wrong — only `send_user_message`, never `start_new_agent`.
- Midpoint (DB Agent rows at 15:47:46): wrong — no new Blue Bottle agent existed when "order submitted" was texted.
- First-bad boundary (delivery): `send_user_message` had no contract requiring claimed side effects to match this-run writes.
- First-bad boundary (trajectory choice): **session history is SMS transcript only**. Prior `start_new_agent` / `kill_agent` / other tool calls are erased to save context. The model therefore saw Jul 25–Aug 3 Blue Bottle turns as pure narration ("fresh agent is placing…", "order submitted…") and treated that script as the policy — without understanding those prior turns often *did* call tools that are simply not shown. Reasoning also said `spawn_agent` (main-agent name); SMS tool is `start_new_agent`, and with no unknown-tool correction it fell through to SMS-only role-play.

## Solution

1. **Prompt (primary, generalizable):** SMS_SURFACE_OVERLAY now states that prior-run tool calls are erased from session history to save space — do NOT assume a prior assistant turn was tool-free; do not reconstruct last-time tool use from SMS text alone; trust the current state block and this run's tool results.
2. **Harness seatbelt:** `messageGrounding.ts` still rejects ungrounded order-progress / agent-lifecycle claims before Surge delivery (incident-shaped defense in depth).
3. Clearer `spawn_agent` → `start_new_agent` unknown-tool error + schema/overlay naming.

Exact-state fixture under `back-end/src/tests/fixtures/sms-bluebottle-hallucination/`. Cemented by unit grounding tests and sms-supervisor blackbox. Catalog entry deferred until the SMS-supervisor runner (`runner: sms` / tag `sms`) lands; blackbox + fixture remain the durable gate.

10k-agent behavior: O(1) overlay text + O(1) regex check per outbound SMS on the per-user supervisor run; no shared fan-in.

## Human feedback

Trajectory root cause is missing epistemic info in context: history never shows previous tool calls, so the model assumed prior turns did not call tools. Fix must teach that erasure explicitly — phrase-regex alone is not generalizable enough.

## Recurrence 2026-09-12

The phrase-regex seatbelt failed to hold — exactly the gap the original human feedback named.

Andy texted `Place my bluebottle order` at 2026-09-12T16:22:25.129Z (SmsSession inboundSeq 23). One supervisor run, Cerebras `gpt-oss-120b`, delivered two contradictory bodies plus the lifecycle `Started:` SMS:

1. 16:22:26.775Z `msg_01m2b6ts4defdtds9nj83t6nz7` — "Your usual Blue Bottle order … is placed for pickup."
2. 16:22:28.178Z `msg_01m2b6ttfne84rsw038rpmfmhk` — "I’m placing your usual Blue Bottle order now."
3. 16:22:31.399Z lifecycle — `Started: "Place my usual Blue Bottle order…"` for agent `86e109a6-e00b-4606-8115-f4fcc4103eb2`

Render tool loop: round 0 `reply_to_agent` fe4168 (paused "tomorrow at 1pm" Blue Bottle, no pending attn); round 1 `send_user_message` + `attempt_completion` (completion correctly rejected — purchase intent without `start_new_agent`); round 2 `start_new_agent`; round 3 second `send_user_message` + completion accepted. Sibling in the same transcript: two identical "Your Lok Lak order is placed for pickup" texts at 2026-09-12T00:34:34Z.

`ORDER_PROGRESS_CLAIM` matched "placing now." and "placed the order" but not "is placed" or "placing your usual … order now". The 2026-08-04 closed phrase list was the failed guardrail. Replacement is `claimsOrderOrPlacementProgress()` — assertive copula+placed, placed-for-fulfillment, placing…now, placing your/the order — so the class of placement claims is blocked, not one captured sentence.

Local repro: `npx tsx src/tests/unit/sms-message-grounding.test.ts` case `2026-09-12 paraphrased is-placed / placing-now SMS rejected` failed on the buggy detector (null) and passed after the class-level matcher. Cemented in that unit file plus `sms-supervisor.bluebottle.behavior.ts` (`2026-09-12 paraphrased double-ack blocked`).

## Reusable lesson

Never gate an irreversible user-visible claim on a closed incident phrase list — match the linguistic class of the claim, because the model will paraphrase the last captured sentence.
