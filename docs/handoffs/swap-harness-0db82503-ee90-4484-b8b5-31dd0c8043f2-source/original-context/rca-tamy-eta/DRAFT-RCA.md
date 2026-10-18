# Draft RCA — Tamara's SMS supervisor asked for eTA fields instead of getting them

## Symptom (prod, 2026-10-07 02:53:07Z, WhatsApp, user 43c2f6ae…, inboundSeq 8)
User: "Filled it for me" (= fill out my Canada eTA; prior turns established Mexican citizen w/ US visa).
Supervisor round 0: one send_user_message, 8-item questionnaire (full name, DOB, passport no+expiry, US visa no+type+expiry,
arrival date, purpose, lodging, email+phone). No grep, no start_new_agent. Round 1 attempt_completion.
Name/email/phone were already in the system prompt (# User Context block). Prod log reasoning:
"I need their personal and passport/visa details to do this. Let me ask for the key information I need to complete the form."
Served by: rose-1-flash; Cerebras qwen-3.8-27b returned 429 → OpenRouter qwen/qwen3.8-27b (reasoning effort low).
Sibling 2026-09-29 00:42Z (gpt-oss-120b, cerebras-direct): "find these documents and draft an email" → "I couldn't locate any of those
documents in your stored files. Could you upload them" — zero tool calls before asking (its reasoning claimed a grep that never ran).
Sibling 2026-10-03 01:09Z: "For the invoice email, send over those documents … and I'll draft it."

## Data check
Her synced data (23k iMessage, 1.3k email) has passport *mentions* but no passport number/DOB/visa number in text. Agents can reach
more (grep drive/calendar, logged-in browser sessions/Gmail). So ideal = delegate (agent finds/asks); acceptable = search first, ask only for
what's missing (never re-ask name/email/phone).

## Reconstruction
back-end/scripts/.rca_capture_seq8.ts (scratch): prepareSmsEnvironment for the user with frozen clock 2026-10-07T02:53:07.235Z,
history truncated to call time. 34/34 messages match prod-logged role+contentLength (system 6671, env tool msg 5810; section lengths
hierarchy 4538 / attention 114 / messages 954 identical). Supervisor code unchanged since 2026-10-03 (git log) so main == deployed.

## Replays (same callSupervisorLlm client path, same schema, temp 0.3). fail = send_user_message with no grep/start_new_agent
Round 0:
- Qwen 3.8 27B, OpenRouter leg (prod leg): 7/10 + 6/10 = 13/20 fail; 9/20 asked name/email/phone.
- Qwen, direct-cerebras route (hedges to openrouter-cerebras): 7/10 fail.
- Model-only swap (POOL_REGISTRY['rose-1-flash'].waterfall = [X] in-process; same route/effort low/schema/messages):
  - moonshotai/kimi-k3: 0/10 fail, 10/10 retrieved/delegated.
  - google/gemini-3.8-flash: 5/10 fail.
  - openai/gpt-6-sol, gpt-5.6-sol: 10/10 unparseable (non-JSON content); gpt-5.6-luna 6/10 unparseable, 4/10 fail. anthropic/* via OR: request errors.
- Contract variants on Qwen (OpenRouter leg):
  - live schema given the authored TOOL_SCHEMAS descriptions (currently dead code): 6/10 fail
  - V3 grounding clause "Ask the user only for information that neither your tools nor an agent you start can obtain.": 8/10 fail
  - V4 start_new_agent capability description: 7/10 fail
  - V5 = V3+V4: 3/10 fail
Full run (read tools executed read-only against prod data; writes recorded not committed; handler feedback shapes):
- Qwen OR leg: 7/10 questionnaire-without-trying; Qwen true prod path (no override): 9/10; p50 1.5s
- Kimi K3 swap: 0/10 and 0/10 (20/20 grep first; 6/20 then start_new_agent; others asked only for passport photo); p50 4.3s, one 58s tail
- rose-1-ultra default route (served gpt-6-sol): 5/10; p50 7.9s, many structured-output retries

## Dead contract finding (contributing defect, NOT causal per replay)
callSupervisorLlm sends only response_model SUPERVISOR_RESPONSE_MODEL (schema.ts). TOOL_SCHEMAS (supervisorTools.schemas.ts) is never
sent to any LLM (only tests import it; unused since at least 2026-03). Dumped live schema: only grep has a description; start_new_agent,
web_search, get_environment, send_user_message, attempt_completion, kill_agent, increase_budget, reply_to_agent have none. Live grep
source enum lacks agent_trajectories although executeGrepTool supports it and TOOL_SCHEMAS documents it. Structural tests
(sms-prompt-layering, user-facing-writing-style) assert text on the dead copy.

## Root cause (proposed)
Classification: Model intelligence limitation. First-bad boundary: SMS supervisor round-0 LLM decision served by
rose-1-flash/Qwen 3.8 27B (supervisorLlm.ts:29 SMS_SUPERVISOR_MODEL; pools.ts:56-65). Controlled model-only replay of the exact captured
call: Qwen 13/20 (round 0, same leg) & 16/20 (full run) skip retrieval and send a questionnaire; Kimi K3 0/10 & 0/20.
Step 5a:
- Why1: served model skips retrieval/delegation (replay).
- Why2: commit a0ef231d5 (2026-08-04) routed the supervisor via Cerebras rose-1-flash (Qwen) one day after case
  2026-08-03-sms-purchase-request-never-delegated-to-start-agent established that delegation quality depended on the serving model
  (Sonnet 5 delegated). rose-1-flash has directAuthEnabled:false so Sonnet never serves.
- Why3: no gate measures supervisor decisions when its model/route changes: every real-LLM SMS supervisor test is opt-in
  (BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1, never set by /deploy); SMS benchmarks only cover restaurant open/closed spawn.
- Why4: design decision (paid real-LLM tests opt-in) → stop.
Problem class: model intelligence limitation in an orchestrator's retrieve-or-delegate-before-asking decision, enabled by an ungated
model-selection change.

## Proposed fix (approval-gated: model policy/cost/latency + new paid deploy test + LLM-visible schema text)
A. SMS supervisor model: move off Qwen 3.8 27B to a model that passes the controlled replay (measured: Kimi K3 via OpenRouter, keep
   Cerebras Qwen out of the primary slot). Tradeoff: p50 1.5s → 4.3s; per-call cost ~2x (Kimi $0.60/$12 vs Qwen $0.425/$2.55 per Mtok).
B. Cement: deploy-gated real-LLM replay of an anonymized copy of this exact request (N=10, assert ≥9 retrieve-or-delegate before asking
   and 0 re-asks of email/phone), run in the back-end blackbox suite unconditionally (not behind the opt-in flag).
C. (Separate, tech debt) Delete dead TOOL_SCHEMAS; make the live zod schema the single source of tool descriptions (incl.
   agent_trajectories in grep source enum). Not causal here.
Golden refs: codex plan.md:41-49,75-90 (discoverable facts: explore first; ask only non-discoverable), hermes prompt_builder.py:499-504,
claude-code messages.ts:3354-3356, openclaw SOUL.md:20 — all encode explore-before-ask in model-visible text; Rose's SMS overlay
grounding rule (contextBuilder.ts:620) treats "came from a user" as an equal grounding source. Prompt variants that added this split
did not fix Qwen (V3 8/10) — so fix A doesn't converge on prompt text; it changes the model, which is the variable the replay proved.
