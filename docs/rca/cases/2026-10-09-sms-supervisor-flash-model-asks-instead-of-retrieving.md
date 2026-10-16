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

The frontmatter classification and first-bad boundary describe the historical
October 9 investigation. The October 16 recurrence below remains unresolved;
that earlier model-intelligence classification is not evidence for its cause.

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
4. **The live tool schema differs from `TOOL_SCHEMAS`.** The zod envelope that reaches the model describes only grep, and omits `agent_trajectories`. The hand-written `TOOL_SCHEMAS` is read only by tests. Native projection no longer wraps every parameter in an `arguments` object (`transforms.ts` flattens it, as Python's tool models do). The user kept the tool text unchanged in this change, so the drift remains open.
5. **Grep returned only the first match window.** Qwen read the Travel docs note with pattern `.` and got back only the synthetic `source: documents` header line. It replied "no numbers in it" and asked for them.
   - Fix: `formatSnippet` now follows ripgrep content mode, as Claude Code's Grep does: every match with `-A/-B/-C` context, merged windows separated by `--`, and at most 250 lines per record with an explicit omission note.
   - Repro: `testDocumentReturnsEveryMatchingLine` in the data-grep blackbox domain. It returned the header line only before the fix.
6. **A regex guard rejected honest questions as claims.** The guard's confirmation-code alternative `confirmation\s*[#:]?\s*[a-z0-9-]{4,}` matched "…email for the confirmation⏎⏎Send…", because `\s` crosses line breaks and any four-letter word counted as a code. Eight questions were rejected, and the run ended in the fallback apology. The same loop recurred on the closed-restaurant benchmark (A/B run 2).
   - Fix (user direction, CLAUDE.md rule 25b): delete the harness text classifiers. That covers the `messageGrounding.ts` claim regexes, the purchase-intent completion block, and the `reply_to_agent` word-overlap check (`smsIntendsAgentReply`). The exact-duplicate send check, argument validation, and the reject-needs-`attention_request_id` rule stay.
   - The single added overlay line targets the incident: "If grep and web_search can't find information you need, escalate with start_new_agent instead of asking the user for it."
   - Removed tests: `sms-message-grounding.test.ts`, the two guard-only Blue Bottle fixture cases, and "unrelated current SMS cannot reply to stale agent". `sms-prompt-layering` now pins the escalate line and that sends are not rejected for their wording.
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

Shipped configuration: native tools, main's tool text plus one grep line ("Search here before asking the user for a fact about themselves…"), the escalate overlay line, and no classifiers.
- Qwen fill-form: 2/3 (Hub 94768ca2, 979711af pass; 6b309cb1 asked for the profile email).
- Without the grep line: 0/2, and Qwen never searched.

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


## Native schema review follow-up (2026-10-13)

The resumed deploy's owning regression exposed a second projection defect:
Anthropic nullable-schema cleanup ran before OpenAI dialect selection, dropping
required nullable fields, and native projection lost the caller's strict flag.
`rose-native-schema` failed on the preserved runtime: `reply_to_agent` lost the
null alternatives and required entries for `attention_request_id` and `reject`.
The exact same assertions passed after separating raw native extraction from
Anthropic cleanup. These are offline request-construction results, not live
provider or benchmark outcome proof.

Native tools, forced tool choice, explicit tools (including `[]`), plain response
models, and direct Anthropic behavior remain preserved. The user approved the
wire correction conditional on retaining the behavior derived in Python
`Rose.complete`; Python provider source is unchanged. The caller's existing
OpenAI strictness and parameter schemas now survive TS native extraction; this
is not byte parity with Python's separate per-tool strict policy.

Adversarial review caught the exclusive OpenRouter entry point bypassing the
Anthropic compatibility schemas. An added wire assertion failed on that path;
internal options now carry the unchanged Anthropic schemas through normal,
exclusive, and nested Cerebras waterfall calls. Both wire assertions then pass.
The compatibility metadata is never serialized into provider request bodies.
Explicit caller tools do not acquire a derived override.

The compact regression is automatically discovered by the backend coverage
blackbox gate. It checks all nine real supervisor argument schemas and their
descriptions, strict true/false/absent, explicit tool precedence, caller
immutability, Responses wire construction, and normal/exclusive Anthropic
waterfall compatibility. At 10,000 agents the change remains bounded by each
request's tool count, with no shared state, new network request, polling loop,
or persistent resource. Applicable integrated deploy gates and live production
verification remain required.

### 2026-10-13 native argument validation follow-up

The fresh three-task supervisor lane failed before any agent spawn. Saved requests carried the authored number/object types, but native Qwen responses supplied numeric budgets and nested grep filters as strings. The SSE and completion adapters preserved types correctly. The native response path reached dispatcher execution without the Zod validation used by the structured content path; budget validation produced a value-only error, and string filters expanded into numeric filter keys.

The dispatcher now applies the existing `SmsSupervisorToolCallSchema` to known tools before side effects and returns its generated type errors through the existing native tool-result replay. Original call IDs, valid arguments, unknown-tool diagnostics, model selection, schemas, static feedback, and round limits are preserved. This follows the user’s conditional approval to preserve the established typed native-tool contract; no string coercion was added.

The existing `sms-supervisor-stream` blackbox domain contains a red-to-green regression for malformed budgets/filters, unchanged typed queued writes, unknown tools, and native ID/error replay. All 16 cases and the native-contract/tool-feedback unit suites pass offline. Live recovery is pending; the failed attempt remains in the append-only history.

The first validation guard over-enforced fields that legacy callers may omit and changed an existing invalid-phase diagnostic. Full coverage caught this in the owning phase/budget unit files. The corrected guard rejects supplied non-null values with wrong authored types; existing executors retain ownership of omitted/null defaults and enum/value validation. The owning 16-case stream, 3-case phase, and 2-case budget suites pass. The interrupted coverage attempt remains recorded; full coverage and live recovery are rerun rather than credited from the failed attempt.

### 2026-10-13 existing Rose.complete and Cerebras wire verification

The resumed source `e96e3c332573b6b9727d6fbce96c18829611fcfc` ran the exact three SMS benchmarks with the unchanged catalog, models and timeouts. Run `cd5b4088-de16-4e0e-8ab1-b5345f250a9d` failed 0/3 in 37.2, 28.8 and 43.0 seconds. Both owning receipts were clean and all five recorded controller/service processes were absent. No root agents were created. The failed attempts remain in the append-only history; this is a third failed focused run, not a successful continuation gate.

Actual Python `call_llm_structured_streaming` rejects malformed native arguments before returning, preserves the rejected native call ID in repair feedback, and caps repeated invalid output at three calls. The actual TS SMS caller returns native arguments before its dispatcher validates them. Python validates/coerces accepted scalar values through Pydantic but does not decode a JSON-string object into a dictionary. The proposed general field decoder was withdrawn and remains private and unapplied. A separate whole-response validation candidate is also unapplied: its unchanged authored Zod schema rejects omissions accepted by the current executor.

Controlled provider requests isolated the tool-schema representation. The same body produced a string budget with both the TS version header and Python's omitted header. Reusing the existing TS Anthropic native projection, while retaining tool descriptions, names, strict flags and all non-tool request fields, produced a numeric budget. A separate matched Grep request produced a typed boolean and omitted unused nullable fields. Raw provider SSE was independently parsed before the TS adapter, so the observed type difference precedes that adapter. This establishes a compatibility difference in these requests; the provider's internal mechanism is unproved, no projected object filter was observed, and these diagnostic requests do not prove the three task outcomes.

The actual nine SMS tool schemas contain 27 nullable fields. Existing projection makes those optional and non-null; their bounds and closed-object flags have no further change because no bound keys or open objects exist. The proposed wiring affects all automatically derived Cerebras tool envelopes, where the full existing projection can additionally strip bounds, close open objects, and remove nullable array/map branches. It is TypeScript Rose code reuse, not literal Python native projection parity. Exact runtime snapshot `69f8742a0139b126707e506e59217a735211b1daf1caba276ca72eeb352b9741` is unapplied and awaiting the user's schema-scope decision `TAMY-CEREBRAS-1`. The existing owning native-schema domain has an additive regression that fails on original runtime and passes in private scratch, including explicit-tool precedence and native IDs; independent review found no blocking revised runtime defect. Raw requests, responses, dumps and test captures remain private with verified persistent SHA256 read-back. This case remains open until the unchanged real benchmarks pass on the applied source and applicable deploy lanes are verified.


### 2026-10-16 Lok Lak rerun and retrieved-fact decision investigation — OPEN

The user explicitly approved replacing “lum lok” with “lok lak” in the paired
restaurant inputs, preserving their identical-input invariant and every fixture,
evaluator, budget and deadline. Commit 6f4dfbaa changes only four catalog strings
and the owning exact-input literal. All 135 SMS owning tests pass. MENU and
USE-RETRIEVED-FACTS remain separate, unapplied pending proposals; neither is
approved by this instruction.

The first rerun failed in setup before any webhook/model call because scoped
credential sync cleared the frozen user's phone. The separate October 16 scoped
seed-profile case records its deterministic red/green proof and c43bcc497 fix.
This first attempt has no TaskResult and provides no SMS outcome evidence.

The fresh canonical local CLOSED rerun on c43 reached the real Qwen path and
FAILED in 38.9 task seconds (98.8225 owning-stage seconds): five successful
web_search calls returned the closed-store fixture, then round 4 called
start_new_agent and send_user_message, followed by accepted attempt_completion
in round 5. One agent and 100 cents of authorized budget violated the unchanged
no-spawn/no-spend evaluator. Its goal acknowledged closure and sought further
verification. This is evidence that the spelling change did not fix the outcome,
not proof of a deterministic regression or an invalid evaluator. The root was
canonically cleaned, independently terminal and durably archived; zero browser
sessions/profiles were allocated, outboxes discharged, exact stack stop exited
zero, the exact database and all 189 observed births were absent.

The earlier frozen-runtime FILL failure remains primary evidence: four successful
grep calls returned the Travel docs note; actual saved final requests contain
its complete text with the matching native tool-call ID. The model asked for
known facts and started zero agents. Executing the unchanged Cerebras projection
offline preserves those bytes, role and call ID. Post-serialization wire capture
from that original run is unavailable; no missing-facts or parser claim follows.

Controlled decision replay is still incomplete. An older private replay helper
incorrectly compared the Cerebras compatibility schemas to the raw authored tool
schemas, throwing before the provider fetch. The product's ordinary waterfall
then served GPT Luna in five trials. Those trials are explicitly excluded from
same-model repeatability and causality evidence; their raw captures are private
and retained. An initial attribution to env loading was incorrect: the active
supervisor alias is a source constant, and the helper assertion caused fallback.

A corrected private observer accepts the exact current approved projection and
requires actual direct Cerebras/Qwen identity before network I/O. Its first
Qwen FILL trial returned grep, rather than the original send_user_message choice.
The old helper's whole-envelope validator additionally rejects omitted nullable
fields that the runtime dispatcher deliberately permits; this diagnostic is not
reported as a runtime parser failure. A CLOSED trial received HTTP429 and has no
behavioral result; attempted fallback was blocked before network. The retry due
is 2026-10-16T21:49:17Z. No replay executes business tools or creates an agent.

Both SMS causes remain unresolved. There is no controlled main-versus-PR
comparison, no model-only capability proof, no prompt fix applied and no passing
post-fix canonical task. The original historical model-limitation classification
above is not adopted for these new observations. The proposed prompt wording is
not a verified causal repair; further identical original-model replays and a
reviewed, unchanged-outcome reproduction remain necessary before closing RCA.

At 21:49:46 UTC, direct Cerebras/Qwen returned HTTP200 for the exact CLOSED
prefix; its chosen tool was web_search instead of the captured spawn/send.
At 21:50:50, a second verified FILL decision returned grep. Both private observers
require the original model, approved provider tool projection, exact projected
messages, temperature 0.3 and high reasoning effort before network I/O. These
samples show decision variability (CLOSED one observed sample, FILL two), not a
passing task or permission to waive either evaluator. No business tool executes
in these observers. A local launcher attempt before the CLOSED sample omitted
the authoritative dotenv and failed before network; its zero-request receipt is
retained and excluded from behavioral evidence. The child launcher now loads the
existing complete backend dotenv without changing any environment file.

A private source/evidence snapshot at 21:43:15 UTC has full gzip read-back of
675/675 members and all 323 source copies verified before and after capture.
Archive SHA256 is
`75364ddb939c34fd754cc2da8ceb17cf784351b3f4688715c925bfc1261bd043`;
root independently verified it. Replay capture in that snapshot is explicitly
partial. The original 418 timing entries remain an exact prefix; the two new
owning stages add two failures, yielding 420 entries (337 passed, 83 failed).
Their ledger-rounded duration is 127.8 seconds; the nested 38.9-second task is
not counted as an additional stage. Raw dumps, profiles and database archives
remain private. Formal deploy eligibility remains false.
