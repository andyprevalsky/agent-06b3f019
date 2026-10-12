---
id: 2026-10-09-sms-supervisor-flash-model-asks-instead-of-retrieving
date: 2026-10-09
title: SMS supervisor borrows the chat-speed model (now Qwen 3.8 27B), which texts a form-field questionnaire instead of searching or delegating
surface: back-end
component: sms-supervisor
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: back-end/src/providers/smsSupervisor/supervisorLlm.ts callSupervisorLlm round 0 — SMS_SUPERVISOR_MODEL rose-labs/rose-1-flash (shared chat-speed pool, Qwen 3.8 27B since 2026-09-29) chose send_user_message over grep/start_new_agent for a delegable fill-out-a-form request
symptoms:
  - "To fill out your eTA I need: 1. Full name (as in passport) 2. Date of birth 3. Passport number + expiry date"
  - SMS supervisor asks the user for information instead of getting it (no grep, no start_new_agent)
  - supervisor asked for email and phone that were already in its # User Context block
  - "I couldn't locate any of those documents in your stored files. Could you upload them here"
  - fall_through_from_cerebras reason=RoseRateLimitError model=qwen-3.8-27b
tags:
  - sms-supervisor
  - whatsapp
  - delegation
  - start-new-agent
  - grep
  - model-selection
  - rose-1-flash
  - qwen
  - ask-instead-of-retrieve
sources:
  - commit a0ef231d5
  - commit 9cf237208
  - commit a12ee01c5
  - commit 2164740da
  - commit 470925c93
repro: agents/benchmarks/tasks.json sms-supervisor-fill-form-searches-then-delegates (scripts/run-bench --local); scoring contract agents/benchmarks/sms_runner_test.py; harness defects back-end/src/tests/unit/rose-native-tool-contract.test.ts, back-end/src/tests/blackbox/sms-supervisor.queued-agent.behavior.ts, data-grep testDialectNormalization
status: open
---

## Problem

The run was found in the Render backend logs: SmsSupervisor, 2026-10-07T02:53:07Z, WhatsApp,
user 43c2f6ae (Tamara Chayo), mySeq 8. She replied "Filled it for me". Earlier turns had
established that she wanted a Canada eTA and held a US visa.

The supervisor's round 0 produced a single `send_user_message`: an 8-item questionnaire asking
for her full name, date of birth, passport number and expiry, US visa number, type and expiry,
arrival date, purpose, lodging, and email and phone. It then called `attempt_completion`. It
never called `grep` or `start_new_agent`. Her name, email and phone were already in its
`# User Context` block. The logged reasoning was: "I need their personal and passport/visa
details to do this. Let me ask for the key information I need to complete the form."

Cerebras `qwen-3.8-27b` returned 429, so the call fell through to OpenRouter
`qwen/qwen3.8-27b` at waterfall effort `low`.

Related incidents on the same surface:

- 2026-09-29, served by `gpt-oss-120b` on the direct-cerebras chat route: "find these documents
  and draft an email" got "I couldn't locate any of those documents in your stored files. Could
  you upload them". No tool ran.
- 2026-10-03: "send over those documents … and I'll draft it."
- Relative case 2026-08-03-sms-purchase-request-never-delegated-to-start-agent: a purchase was
  asked back instead of delegated.

What was findable in her synced data:

- 0 `UserDataDocument` rows, so no documents, Drive or Calendar.
- About 23k iMessage records.
- About 1.3k emails, with sync ending 2026-05-17.
- Passports are mentioned, but no passport number, visa number or DOB appears in text.

Only a spawned agent could look further, through live Gmail or browser sessions. So the right
outcome is to search first, then delegate or ask only for what is missing, and never re-ask for
known contact fields.

## Diagnosis

### Reconstruction

The round-0 request was rebuilt from prod data with a frozen clock and history truncated at
call time (`.context/rca-tamy-eta/scripts/rca_capture_seq8.ts`). All 34 messages match the prod
log on role, content length and 100-character preview. The Qwen replay reports the same
`prompt_tokens` as prod (9168). Supervisor code is unchanged since 2026-10-03.

### Controlled replays

Script: `.context/rca-tamy-eta/scripts/rca_eval.ts`. Each replay is a full run. Reads (`grep`,
`web_search`) execute read-only. Writes are recorded and never committed. The served model is
captured for every call.

A run fails if it asks the user before any `grep` or `start_new_agent`, or if it re-asks for
contact info.

| Configuration | Fails | p50 | p95 |
| --- | --- | --- | --- |
| Qwen 3.8 27B, prod default path (served Cerebras high in 23/30 first calls) | 24/30 | ~1.4s | 5–18s |
| Qwen on OpenRouter, high effort | 14/20 | | |
| Qwen on OpenRouter, low effort | 16/20 | | |
| Qwen with authored tool descriptions in the live schema | 27/30 | | |
| Model-only swap to Kimi K3 (same route, effort, schema and messages) | 4/50 by scorer; 0/50 asked without trying | 4–10s | up to 68s under concurrency |
| Gemini 3.8 Flash | 5/10 (round 0) | | |

- **Kimi K3:** 34/50 searched first and then asked only for the passport; 16/50 delegated. All
  four flagged Kimi runs were confirmations of the known email, not requests for unknown facts.
- **Anthropic legs** on OpenRouter return 400 ("Schemas contains too many parameters with union
  types"). This is the schema-limits case.
- **OpenAI legs** mostly emit non-JSON on this path.

Changing only the effort level and the reasoning route does not move Qwen. Changing the model
moves the outcome.

### Step 5a ladder

1. The served model skips retrieval and delegation (controlled replays above).
2. The supervisor has no model of its own; it rides the shared chat-speed path:
   - 2026-08-04, commit `a0ef231d5`: direct-cerebras chat route, ending claudeAuth Sonnet. Case
     2026-08-03 had just shown Sonnet delegating.
   - Then GLM, then `gpt-oss-120b` (commit `9cf237208`).
   - 2026-09-28/29, commits `a12ee01c5` and `2164740da`: rose-1-flash pool with Qwen 3.8 27B.

   Every retarget was justified by chat TTFT, tok/s or benchmark-index numbers.
3. No gate measures supervisor decisions when that shared model changes. All real-LLM SMS
   supervisor tests are opt-in (`BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1`), and `/deploy` never sets
   that flag. The SMS benchmarks only cover restaurant open/closed spawning.

### Contributing defect (not causal per the replays)

`TOOL_SCHEMAS` is never sent to the model; only tests import it. The live schema describes only
`grep`, and its grep source enum omits `agent_trajectories`.

### Harness defects exposed by the model-swap test

Testing GPT-6 Sol (rose-1-ultra, served by Azure Foundry) on the matched benchmark found four harness defects. Sol searched on every run, but these defects broke what happened next.

1. **Native tools reached Anthropic legs only.** The supervisor's tool-envelope `response_model` was projected into native tools only on the Anthropic legs. The Responses, Cerebras and OpenRouter legs received a JSON `response_format` instead. Python Rose.complete projects that envelope into native tools on every leg; TS had no equivalent.
   - On Responses, Sol wrote one envelope per step across `commentary` and `final_answer` message items. `StructuredOutputAccumulator` keeps only the final item, so 1 of 5 planned calls executed.
   - On OpenRouter, the envelopes arrived concatenated and failed `JSON.parse`, producing an empty round.
   - The pool waterfall also dropped explicit `tools` entirely.
   - Fix: `withNativeToolContract` with per-dialect tool and tool_choice shapes (`providers/rose/toolContract.ts`, mirroring Python's `_openrouter_tools` and `_responses_tools`). The supervisor now replays each round as the model's real tool calls, with one result per call.
   - Repro: `src/tests/unit/rose-native-tool-contract.test.ts` fails on the old client because no `tools` are sent.
2. **Queued agents were unaddressable.** `start_new_agent` returns a provisional ID, but `reply_to_agent`, `kill_agent` and `increase_budget` resolved only committed rows. Sol replied to the ID it had just been given and got "No agent found". The commit creates exactly that ID, and writes commit in order, so these tools now resolve agents queued earlier in the same run (`resolveAgentTarget`).
   - Repro: `sms-supervisor.queued-agent.behavior.ts`.
3. **Word boundaries in grep matched nothing.** Patterns are validated as JS RegExp but run as Postgres ARE, where `\b` is a backspace. So `\bpassport\b` silently matched nothing. `translateWordBoundaries` maps `\b` and `\B` to `\y` and `\Y` outside bracket expressions.
   - Repro: `testDialectNormalization` in the data-grep blackbox domain (0 matches before the fix).
4. **The live tool schema differed from `TOOL_SCHEMAS`.** This is the contributing defect above, with three parts:
   - The zod envelope that reached the model described only grep. Its other tools went out with empty descriptions.
   - It omitted `agent_trajectories`.
   - Its native projection wrapped every parameter in an `arguments` object.

   `TOOL_SCHEMAS` is now derived from the zod schema, so they cannot drift. Extraction flattens the parameters, as Python's tool models do. The descriptions are grounded in the reference harnesses:
   - Claude Code's Agent "Writing the prompt" section and Hermes `delegate_task`: the agent starts with zero context, so brief it with every known fact.
   - Claude Code's SendUserMessage and OpenClaw's `message`: only this tool reaches the user.
   - Hermes `session_search` and OpenClaw `memory_search`: search before asking the user.

   Approved 2026-10-12.
5. **Grep returned only the first match window.** Qwen read the Travel docs note with pattern `.` and got back only the synthetic `source: documents` header line. It replied "no numbers in it" and asked for them.
   - Fix: `formatSnippet` now follows ripgrep content mode, as Claude Code's Grep does: every match with `-A/-B/-C` context, merged windows separated by `--`, and at most 250 lines per record with an explicit omission note.
   - Repro: `testDocumentReturnsEveryMatchingLine` in the data-grep blackbox domain. It returned the header line only before the fix.
6. **A regex guard rejected honest questions as claims.** The guard's confirmation-code alternative `confirmation\s*[#:]?\s*[a-z0-9-]{4,}` matched "…email for the confirmation⏎⏎Send…", because `\s` crosses line breaks and any four-letter word counted as a code. Eight questions were rejected, and the run ended in the fallback apology. The same loop recurred on the closed-restaurant benchmark (A/B run 2).
   - Fix (user direction, CLAUDE.md rule 25b): remove the harness classifiers in `messageGrounding.ts` (order-progress, agent-start and agent-kill claims) and the purchase-intent completion block. The overlay's existing grounding rule covers claims. Per the user, the single added overlay line targets the incident itself: "If grep and web_search can't find information you need, escalate with start_new_agent instead of asking the user for it."
   - The exact-duplicate send check stays, since it is equality, not classification.
   - Replaced tests:
     - `sms-message-grounding.test.ts` and the two guard-only Blue Bottle fixture cases are gone.
     - `sms-prompt-layering` pins the escalate line and that sends are not rejected for their wording.
   - Qwen started an agent for the closed restaurant in 0/2 runs with the guard and 0/2 with main's schema text, so that failure predates this change.

Matched benchmark `sms-supervisor-fill-form-searches-then-delegates` (local), across the fix stages:

| Served model | Before | Fixes 1–2 | All six fixes |
| --- | --- | --- | --- |
| Qwen 3.8 27B, prod default path (Cerebras) | 0/6 | 0/2 | 1/2 |
| GPT-6 Sol via Foundry | 0/4 | 1/3 | 3/3 |

Hub runs for the final stage:
- Qwen: 154a774b (pass), 00dae9ab
- Sol: 826deccc, 29ff802c, 04e0e091

The remaining Qwen failure asked for an email address that is already in the profile.

The production decision remains a model-selection question.

### Relative, not recurrence

The 2026-08-03 fix, getting claudeAuth accepted, still holds. The supervisor simply stopped
using that path, so the first-bad boundary differs.

## Solution

Outcome gate (user-requested): benchmark `sms-supervisor-fill-form-searches-then-delegates` replays the eTA thread with a synthetic Travel docs note seeded into the user's searchable documents; it requires one started agent whose goal carries the note-only passport and visa numbers, plus a judge that no SMS asks for facts in the note or profile. Pre-fix local run on main (Hub run d1e47d09-617c-46e6-9e4d-8225b218e208): FAILED — Qwen grepped and found the note but started the agent in the same round (goal lacked the numbers), then texted "Got your passport (Mexican, G58219473). I need a few more things…" asking for DOB, birthplace, email and US visa details that were in the same note or profile. `sms_runner_test.py` is now executed by the agents benchmark blackbox gate (it was previously never run).

Proposed, pending approval (model latency, cost and policy; a new benchmark definition):

- Give the SMS supervisor its own model selection, decoupled from the chat-speed pool and chosen
  by supervisor-decision evals.
- Cement an anonymized copy of this conversation as a `runner: sms` benchmark in the predeploy
  `sms` floor. It should assert retrieve-or-delegate before asking.

Kimi K3 passes but costs latency, and it has an open web_search/grep mismatch case on this
surface.

## Human feedback

None recorded.

## Reusable lesson

Never let a decision-making orchestrator inherit a shared speed pool's model without a gate that
replays its captured decisions, because pool retargets justified by chat latency silently change
whether it retrieves, delegates, or asks the user.
