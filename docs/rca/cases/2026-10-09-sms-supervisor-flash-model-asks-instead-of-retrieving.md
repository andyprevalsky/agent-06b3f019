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

### Fresh full FILL rerun, 22:00 UTC investigation — OPEN

Canonical `scripts/run-bench --local sms-supervisor-fill-form-searches-then-delegates`
on 3710f0fc1 (run 1792187378-1677844-85311) FAILED in 45.0 task seconds;
its original timed owning stage records 79.9 seconds. All four actual model
calls were Qwen 3.8 27B. The unchanged evaluator reported zero started agents
where one was required. The trace is reaction, two successful grep calls in
round zero, send_user_message, then accepted attempt_completion. Full current
SMS owning pytest passed 135/135 before this run; source/hash qualification is
explicitly diagnostic only, with no fresh full-G3 or deploy eligibility claim.

This FILL attempt has a different immediate retrieval boundary from the older
666 failure. Its documents grep returned zero matches, and its message search
did not supply the Travel docs note. The actual saved bad-request prefix lacks
the note's content and exact field values. The documents pattern uses lowercase passport/date-of-birth
alternatives without the optional case-insensitive flag; other alternatives
include uppercase terms. Running that exact
pattern and seeded title/content through the actual validateGrepInput and
regexPredicate into a read-only PostgreSQL scalar query returns false with the
unchanged default and true when only the existing `-i` argument is supplied.
This scalar-literal probe demonstrates an input-dependent search miss for the
catalog text, not a grep implementation defect or authority to change its
default. The runtime log reports one successful document seed, but a positive
row read-back joining that exact document, user and source to all search filters
was not captured; case sensitivity remains a candidate mechanism for this actual
zero-hit query, not a completed causal diagnosis. The later choice to
ask rather than delegate still violates the task outcome. The earlier FILL
request really contained the retrieved note; these two paths are not conflated.

Two verified original-model CLOSED decision samples chose web_search and
(two) grep calls, respectively, instead of the saved spawn/send decision.
The two verified old-prefix FILL samples chose grep. No business tools execute
in these observers; none is counted as a passing canonical task. The older
wrong-model samples and HTTP429 remain excluded from behavioral comparison.
An independently executed origin/main classifier replay accepts both actual
inputs and outgoing messages. Thus deleting those classifiers did not change
acceptance for these specific samples; this is not a complete main/current
canonical comparison. The private executable/result hashes are respectively
`68be791eb8c042d09843a5e9cbeceed5de35e2bdda28ddbe7d391f02e434fcaf`
and `795fafd526f8b337176664cb320cb8a52f90699bf4f4c8910034b185d4196c0d`.

Fresh FILL canonical task cleanup verified all 51 owned seeded fixture rows,
with zero actual native workflow generations and zero positive browser/profile
allocations. Latency/log diagnostics exited zero; the cache diagnostic exited
one because the seeded fixture root had no llm.cache events. That failure is
retained and cache metrics remain unavailable. The exact DB dump and four
source-bound backend LLM dumps were copied privately before stop. Root-reviewed
canonical stack stop exited zero, and the observer exited zero. The exact DB
and all 20 post-task-observed process births were absent. Observation began
after task termination; complete descendant capture is explicitly unproved.

Private archive SHA256
`5c21f1312843a83d1b0b004ae9b2324222129defb5206ae45bc8164cf76c4b3d`
has full persistent read-back of 263/263 members and all 323 source bindings;
cutoff is 22:01:02 UTC. Its source payloads are tied to the prior verified
source archive. The later read-only case-sensitivity probe is a separate
supporting artifact, not silently included in that snapshot. Timing keeps the
420-entry exact prefix and adds this failed owning stage: 421 total, 337 passed,
84 failed. The nested 45-second task is not double-counted as another stage.

No new prompt, schema, model, decoder, classifier, fixture or timeout has been
applied. MENU and USE-RETRIEVED-FACTS remain unapproved experiments, not verified
repairs. Both business-behavior RCAs remain open. Decision variability alone
does not establish harmless flakiness, model capability causality or a PR-induced
regression. A valid next experiment must preserve these failures, hold its
variables constant, and obtain any required exact approval before changing
LLM-visible inputs.

A bounded same-provider diagnostic comparison is now prepared but unapproved:
TAMY-MODEL-ONLY-REPLAY-1, at most 12 inference requests (three pairs per saved
CLOSED/old known-fact FILL prefix), Qwen versus GPT-OSS120B. Offline full-body
proof shows only the model field differs, and the baseline FILL body matches
an actual successful Qwen wire capture. The private process-local override is
restored, fallback/retries are blocked, and online mode requires a positive
user-approval receipt and exclusive once intent. No business tool executes.
Both support configured high effort according to current official provider
documentation; equal underlying reasoning-token budgets are not claimed. This
is not a proposal to deploy GPT-OSS or presume it superior. It may remain
inconclusive, and cannot substitute for the canonical task outcome gate.
The user's existing model-change boundary requires explicit permission before
this experiment. The approval request was presented; no answer or new model
inference is inferred. Original MENU/USE-RETRIEVED-FACTS proposals remain separate
and unapplied. Helper SHA256 is
`a0be3bee8cf510f74ec04a222685cb4e7927cf2d14323ed47c4b661ff26894a5`.

### User-requested pickup-right-now wording, October 18 — still failing

The user explicitly requested an immediate-pickup formulation and another stop
check. Commit d2ded2c18396771790138f7a9bd347dfc0f19e16 changes the paired
OPEN/CLOSED catalog prompt and inbound to
`Order me a lok lak for pickup from the ferry building right now`, plus the
existing owning exact-input literal. All other task fields, fixtures, evaluators,
budgets, models and deadlines are byte-preserved. The full owning suite passed
135/135 with no skips or deselection. This approval does not cover the separate
MENU, USE-RETRIEVED-FACTS or model-comparison proposals.

Fresh canonical CLOSED run 1792347408-2099788-19268 FAILED in 44.5 task seconds;
the original stage ledger records 83.8 seconds (84.009-second outer monitor).
All 12 observed backend calls served Qwen. Across rounds 0–9 it executed 16
successful web searches and three successful greps, then reached the round cap
without calling attempt_completion or send_user_message. No agent started and
no authorized budget increased. One runtime limit/error fallback SMS was sent;
it did not convey closure. The unchanged completion evaluator rejected the run.
Thus the revised immediate-pickup request still does not produce the correct
stop. This is observed failed behavior, not a completed causal diagnosis or a
claim that this PR introduced the loop.

Canonical task cleanup verified zero allocated roots, zero actual native
workflow generations and zero browser sessions/profiles. The exact owned DB
and all 158 process births observed from launch were absent after root-reviewed
canonical stop, which exited zero. The passive observer exited zero. Complete
descendant capture is explicitly unproved. All 12 backend-emitted model dumps
and an owned DB dump were preserved privately before stop. Raw content remains
private. No new runtime prompt, model, schema, decoder or stopping rule was
applied during this check. The earlier failed attempts remain intact.


### Real-model final-response verification, October 18 — canonical task remains failed

After the exact terminal instruction was presented, the user directed validation
against the real model rather than treating a mocked answer as the outcome.
Checkpoint 30f59a07ce259976da37e951a49b48fd1552b74c applies that snapshot: the
ten-round work budget is followed by one closing turn. Its instruction is
appended to the last real tool result; an atomic guard rejects new work or
multiple user replies on that turn and records rejected calls. Previously queued
writes retain the existing ownership, cancellation and commit checks. Models,
schemas, catalog definitions, fixtures, retry policy and timeouts are unchanged.

Problem class for this terminal change: bounded work can consume its budget
without a final opportunity to publish the evidence already gathered. The
next-deeper candidate, generating a model reply on every terminal exit, is not
coherent when the model is unreachable or the run is cancelled/superseded.
Hermes `agent/chat_completion_helpers.py:2296` requests a final summary after
its iteration cap; Rose adapts that pattern using its actual tool-result
channel and existing send/completion tools. No synthetic user turn is added.
The existing handler owner fails on the old handler with zero closing calls
(expected one), and passes on this snapshot with cancellation, queued-write
failure and rejected-call trace coverage. This mocked owner proves control
flow only. Current backend typecheck and all135 SMS owning tests pass.

The unchanged canonical CLOSED task, run1792348761-2321589-final, still FAILED
in53.2 task seconds/83.7 owning-stage seconds. All three supervisor model dumps
served Qwen3.8-27b. Round0 called start_new_agent and send_user_message;
round1 called attempt_completion. It searched zero times, started one root and
increased authorized budget by100 cents. The unchanged no-spend evaluator
rejected that increase. One supervisor reply and one separate lifecycle
notification were captured. The closure judge was not reached. The cap change
was never exercised in this run, and this evidence does not show that it
caused the earlier round0 decision. No complete causal/model-capability
diagnosis or successful business outcome is claimed.

A separate one-call real-model continuation directly tested the closing
instruction. The exact original last-call dump was receipt-hash verified; its
32-message prefix was preserved, followed by the two actual native round9
calls and their complete662-character results. The normal feedback and the
approved terminal instruction produced35 input messages and the unchanged
nine-tool catalog. The actual Qwen call generated a contextual closure reply
through send_user_message, but omitted attempt_completion. No business tool
was dispatched and no SMS was sent. This replay bypassed handler delivery,
ownership and commit checks: it proves contextual generation on that snapshot,
not completion acceptance or a full benchmark pass. Independent read-only
audit verified the input, call IDs, results, provider request and qualifications.
The earlier replay setup attempt rejected dirty benchmark-history output
before any once intent, child or model call; that failed attempt remains in
the ledger. The subsequent admitted request made one actual model call.

Canonical cleanup verified the one original workflow TERMINATED and zero
browser allocations. Three actual root diagnostics exited0. The terminal
and archive outboxes were empty with one durable archive reference. After
private dump read-back and root review, canonical stack stop exited0, the
owned DB was absent and all147 observed process births were absent; complete
descendant capture remains unproved. Both the passive observer and direct
model-call child were joined. All raw content remains private. Persistent
archive SHA2569a693c038676cbe0f51c16a8d292241a3d10791b5e13209fb70d4ef368afd412
has full566-member read-back and all324 source copies verified, cutoff
2026-10-18T18:59:50.499113Z. Later safe receipts and this case append are not
claimed to exist inside that archive. Original244/c8 ancestry and the exact
original source-snapshot subtree remain intact.

Archive searches used the unauthorized-budget symptom and the CLOSED
start_new_agent/no-web_search behavior. This remains an open recurrence
in the existing SMS investigation. Original-plus-resumed history now contains
428 owning attempts:341 passed/87 failed,31 original+397 resumed. Diagnostic
request exit0 means observation completed, not a benchmark pass; nested clocks
are not counted again. No alternate model or previously unapproved MENU/
USE-RETRIEVED-FACTS proposal was applied. Full current deploy verification,
exact-HEAD bounded review, merge and production lanes remain outstanding.


### Explicit same-response send/completion instruction, October18

The user directed the cap instruction to request send_user_message plus
attempt_completion, and asked for the unchanged benchmark input, criteria and
actual outcome. Exact one-line diff was shown before application. Runtime
158d3e1e262b4e0fddf1fa532ff5e9f2cb7ae937 now explicitly requests both calls
in the same response, in that order. No other runtime instruction, model,
schema, classifier, catalog, fixture, retry policy or timeout was changed.
The existing handler owner and backend typecheck exit0; all135 SMS owning
tests pass. These owners do not substitute for a real-model outcome.

Fresh canonical run1792350783-2643178-pair PASSED the unchanged CLOSED task
in30.8 task seconds/63.2 owning-stage seconds. Input is still the exact
paired immediate-pickup request. All eight source-bound SMS model dumps
served Qwen3.8-27b. Across seven work rounds it ran eight web searches,
sent one supervisor reply conveying the closure, then called completion
which the handler accepted. No agent or authorized budget was added. Both
the static contract and semantic closure evaluator scored1.0. The loop
stopped before the cap: this is a real benchmark PASS, not proof that the
new closing instruction caused it or that the capped two-call path works.

The separate real-model continuation preserves the verified original
35-message history and nine native tools; only the user-requested terminal
line differs from the earlier replay. The actual request contains the exact
new instruction. Qwen still generated only send_user_message and omitted
attempt_completion. It ran no business tools and delivered no SMS. The
expected same-response pair therefore remains NOT_MET. Independent source/
dump audit found both tools available and no one-call restriction. Rose's
collected native output already contains just one call, and the SMS finalizer
preserves it. This capture is normalized output, not raw provider SSE, so no
precise upstream cause is proved. Do not infer harmless flakiness, model
incapability, or a fixed cap path from this single observation. The initial
replay setup rejection was before once intent or inference; both setup and
actual observation attempts remain in the ledger.

Canonical cleanup verified zero roots, native generations and browsers.
There were zero applicable root diagnostics, not three passing diagnostics.
The owned terminal/archive outboxes were empty. Eight model dumps, exact
owned DB dump and the replay request/response were preserved privately before
root-reviewed stack stop. Canonical stop exited0, observer and replay child
were joined, the owned DB was absent, and all136 observed process births
were absent. Complete descendant capture remains unproved.

Original and failed attempts remain intact. Current full deploy gates,
unresolved FILL behavior, cap-pair reliability, bounded exact-HEAD review,
merge and production verification remain outstanding. No production deploy,
alternate-model comparison or previously unapproved prompt proposal is
implied by the single canonical PASS.

Private archive SHA256 f27fd21d0981d069c7c4d73faddb00cceee6e9fbb5ce3940d3e1655213b35608 has full457-member read-back and all324 source copies verified; cutoff 2026-10-18T19:21:15.277233+00:00. Later safe receipts and case/scorecard updates are outside that archive. The original31 and resumed403 owning attempts are retained:434 total,346 passed/88 failed. Nested clocks are not double-counted.

### October 18 synced FILL: retrieval and delegation pass, profile country re-asked

The user requested the same real-run process for the second failing benchmark.
Canonical local run `1792353705-3076059-fill` used synced source
`fcdbc6fa4de66f425f8a49bbecbfebb46f4d6a98`. The complete FILL task object
remained SHA256 `6f1bbd62321cc1da406e1d7bc8cda3fc171d0e661112b6908cdfea073bf7ae97`,
with the original 420-second limit and unchanged input, fixture and evaluators.
The actual input was `Filled it for me` in the existing Canada eTA thread.
No response mock, alternate model, decoder or new prompt change was used.

The result was **FAIL**, with 61.3 seconds on the combined task/evaluation/
cleanup clock. Seven successful grep calls retrieved the Travel docs note.
Round4 started and committed exactly one application agent whose goal carried
both required passport/visa values, then sent one supervisor reply. Round5
accepted attempt_completion. The static search/delegation evaluator scored
1.0/PASS. This run did not reproduce the prior zero-agent retrieval failure.

The unchanged semantic evaluator scored0.0 because the reply requested a
current residential address including country, while the available profile
already contained a country. All six actual nonreaction model requests included
that country in their system profile context, including the 48-message,
nine-tool call that emitted the reply. Its collected native send body exactly
matched the persisted successful send. The actual profile supplied location,
not a complete verified residential address; this evidence does not establish
that the remaining address fields were known.

Seven source-bound backend dumps verify actual Qwen3.8-27b calls, with no
blackbox-response-fixture marker. The failing request, native output and full
tool history are preserved privately. An independent review confirmed the
country re-ask against the unchanged evaluator and actual visible context.
This is an observed failure, not proof of flakiness or model-intelligence
causality; no controlled model comparison or behavioral fix is claimed.

Canonical cleanup verified both roots and52 owned rows, one actual native
generation was independently read back TERMINATED, and exact provider
inventories contained zero browser sessions. Two durable archive references
and empty terminal/archive outboxes were verified before stack stop. Five of
six root diagnostics exited0; the historical fixture root's cache diagnostic
had no events and remains a warning. Canonical stack stop exited0; the observer
and controller were joined, the owned database was absent, and all186 observed
process births were absent. Complete descendant capture remains unproved.
Safe durable results and the continuing full-attempt scorecard record this
source scope. This is not a full current deploy pass or production acceptance.

- 2026-10-18 private FILL archive readback completed at 2026-10-18T20:25:31.728030+00:00: helper exit 0; SHA256 `3f03c6d2ba33c32283156bc972c6ec47acfa804f81555e203cb01448a66dc3ab`; 266,759,819 bytes; all 4,459 members and 4,214 captured source hashes verified. Cutoff 2026-10-18T20:08:24.657058+00:00. Reconstructed-request and followup metadata created after cutoff are outside this archive. This proves preservation, not benchmark PASS or deploy acceptance.

- 2026-10-18 initial-state FILL rerun at source `3882424951a99a7d173729622153c845d561afb8`, with the user-approved confirmation/defaults system line: **FAIL**, 69.9 seconds, static 1.0 PASS, semantic 0.0 FAIL. Supervisor retrieved Travel docs, delegated once, replied once, and completed in round 4. The semantic failure came from the delegated agent lifecycle message reasking country. The supervisor itself omitted country but did not show assumed defaults. Six actual SMS model dumps preserved privately; no response mock. Exact native generation terminated, two durable archive refs, zero provider sessions, empty outboxes, owned DB and 193 observed process births absent after canonical stop. Passive observer failed while reading the partially written trigger JSON; independent terminal custody was verified. Seed-fixture cache diagnostic remains a no-events warning. No behavior fix or deploy acceptance claimed.

- 2026-10-18 Tamy-account FILL rerun, source `f62f6ad8b043fb01f5ad33edd68caacc38e1b5bf`: **PASS**, 63.6 task seconds, static 1.0 and semantic 1.0. Existing account snapshot loaded Tamy before the unchanged seeded regression conversation; six actual SMS model dumps retained privately. One supervisor reply and one delegated start acknowledgement, with no follow-up question. This establishes benchmark success for this account/state, not eTA submission or whole-deploy acceptance. Exact workflow terminal; one browser session deleted; its positively new profile deleted and independently 404; no recording returned; two archive refs and empty outboxes. Canonical stack stopped, owned DB absent and all observed process births absent. Six diagnostics completed; seeded old-root cache no-events warning retained.


### October 18 integrated deploy validation

Runtime `2a7c873fdb18f33997562630dda51e58d83d20fa` passed fresh backend
coverage (201 blackbox domains, 299 unit files plus isolated analyzer; 89.61%
line coverage), static checks and all three live probes. The unchanged frontend,
agents, controller, command and cold-seed components retain their explicitly
recorded earlier execution sources: 2,806 frontend tests (3 existing skips),
110 agent blackbox domains, 196 cache regressions, 152 unit tests, all 12
controller commands, all 47 command suites, and 5/5 seed fidelity checks.

Current-runtime semantic UI passed 8/8; latency passed 20 measured samples;
real E2B passed 56/56 with no skip. Current smoke passed all 10 tasks, including
the cached 50-child task. Sandbox AgentCard completed with 3 passes and the
standing approved release-stall skip, not four passes. The skipped transfer
remains consumed with 4,396 cents unreleased and its refund pending.

Independent native readback verified 61 smoke workflow generations completed,
five smoke browser sessions deleted, one smoke code sandbox absent, all four
AgentCard workflows terminal and all five AgentCard browser sessions deleted.
Canonical stack cleanup completed; all 1,510 smoke and 1,527 AgentCard observed
process births were absent. Before database teardown, smoke still showed
61 terminal and 9 archive obligations across its two contexts; AgentCard showed
4 terminal and 4 archive obligations. These observations are retained: native
effects were verified separately, and database disappearance is not evidence
of empty persistence outboxes. Smoke retained 65 expected post-stop observer
rejections, not a zero-error claim. Three settled smoke purchases were checked
read-only in AgentCard sandbox/Stripe test mode: cards closed, captures settled,
transfers partially released; no full-return claim or extra refund mutation.

The general agent execution loop retried one idle timeout and one rejected
plain-text AgentAction response during the last AgentCard case; this was not
the SMS-supervisor route and no model/schema/timeout was changed. Original
operator failures, the treasury TEST mint pending reclamation, and all timing
attempts remain recorded. The original production release-stall waiver applies,
but independent live-Stripe exception `TAMY-PROD-MODE-2` is still awaiting a
decision. No override, merge or production acceptance is claimed.
