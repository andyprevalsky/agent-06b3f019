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
  - "agent started" SMS with no Agent row created
  - "killing old blue bottle agents and starting a fresh one"
  - SmsSupervisor toolNames=["send_user_message"] for every round while reasoning says "Use spawn_agent"
tags:
  - sms
  - supervisor
  - hallucination
  - start-new-agent
  - spawn-agent
  - blue-bottle
sources:
  - agent 7e9fd03c-7b8c-4611-80d6-f709bef62540
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

## Reusable lesson

When a harness strips tool transcripts from history to save context, the prompt must say so. Otherwise the model learns "SMS narration without tools" as the local policy and replays it. Complementary: never let a messaging tool claim write-side-effects the current run did not perform.
