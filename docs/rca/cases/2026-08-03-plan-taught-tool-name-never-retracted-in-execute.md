---
id: 2026-08-03-plan-taught-tool-name-never-retracted-in-execute
date: 2026-08-03
title: PLAN's FSM prompt teaches `send_message_to_user`, EXECUTE's union rejects it, and the parse retry re-asks byte-identically
surface: agents
component: prompts-and-tool-schemas
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/prompts.py:209 build_system_prompt — accepts enabled_tools/disabled_tools/tool_prompts and uses none of them, so the EXECUTE system prompt never retracts the tool names PLAN_PHASE_PROMPT enumerated
symptoms:
  - "LLM call failed 3 consecutive times: ValidationError: 15 validation errors for AgentAction"
  - "Input should be 'spawn_agent' [type=literal_error, input_value='send_message_to_user', input_type=str]"
  - "LLMStructuredOutputError: Failed to parse streaming Rose response as AgentAction"
  - "Tool detected: default_api:send_message_to_user"
  - "anthropic_openrouter_response_format_unsupported"
tags:
  - structured-output
  - tool-schemas
  - phase-transition
  - prompts
  - execute-phase
  - gemini
  - retry
sources:
  - agent 16ae3e8f-1e0f-4004-9c58-b74fe34c8a1e
  - commit e60f1a270
  - commit be1cfd82f
repro: agents/tests/blackbox/run_agent.blackbox.py::test_failed_llm_call_does_not_consume_iteration_budget
status: mitigated
---

## Problem

Prod agent `16ae3e8f-1e0f-4004-9c58-b74fe34c8a1e` (source `MAC_APP`, model
`rose-labs/rose-1-ultra`, user Tamara Chayo) ran 2026-07-29 19:57→21:15 UTC on a
"cheapest direct flights for a 4-city Europe itinerary" goal and ended
`status=FAILED` with:

```
LLM call failed 3 consecutive times: ValidationError: 15 validation errors for AgentAction
tool_calls.0.function-after[check_spawn_agent_constraints(), SpawnAgentTool].tool
  Input should be 'spawn_agent' [type=literal_error, input_value='send_message_to_user', input_type=str]
```

71 minutes, 1,002,537 tokens, 702 of 1000 cents. Every leg of research it had
already completed was discarded; the user got nothing.

Runtime evidence, from the retained `observability.fly_logs` context dump
(`llm.context.dumped`, `dump_id=947970d2345c`, `call_site=execute_loop`) for the
final failing call:

- `response_format` is `{"type":"json_schema","strict":true}` whose `tool_calls`
  `anyOf` has exactly 6 `const` names: `spawn_agent`, `wait_for`,
  `send_message_to_user_execute_phase`, `call_phone_number`, `message_person`,
  `attempt_completion`. `send_message_to_user` is **not** among them.
- The model emitted `{"tool": "send_message_to_user", "message": ...}`.
- The 3 system messages contain **zero** occurrences of either messaging tool name.
- 4 conversation messages **do** contain the bare name, including a `role=tool`
  message carrying `"name": "send_message_to_user"` from the PLAN phase, where
  the tool legitimately exists and was called successfully twice.

The same invalid name recurred five times across the run: 20:34:07 (as
`default_api:send_message_to_user`), 20:39:35, 20:59:50 (consecutive=1), 21:05:23
(consecutive=2), 21:09:06 (consecutive=3 → FAILED).

A research sub-agent died separately of the same *class* but a different cause:
it emitted `{"tool": "default_api:local_grep"}` — the real tool is `grep`, so
Gemini both namespace-prefixed and renamed it. `loop/run_agent.py:686` increments
the iteration counter BEFORE the LLM call, so each failed parse burned a turn:
iteration 19 (failure 1) → iteration 20 (failure 2) → "Reached max iterations
(20)". It had completed 18 turns of real work and spent its last two re-asking
an identical question. This is NOT the PLAN→EXECUTE rename.

## Diagnosis

**Why 1 — the model named a tool that is not in the EXECUTE union.** Proven by
the decoded dump above: schema offers `send_message_to_user_execute_phase`, model
emitted `send_message_to_user`.

**Why 2 — it learned that name from the harness, in prose, and was never told it
changed.** `agents/utils/prompts.py` `PLAN_PHASE_PROMPT` is an explicit FSM that
lists `send_message_to_user` as an "Enabled tool" in three of its four states
(lines 151, 156, 158, 162). `EXECUTE_PHASE_PROMPT` (169-175) enumerates **no**
tools at all. The model's own reasoning in the failing context quotes that FSM
back verbatim — msg[6] *"given the FSM structure … I can use `send_message_to_user`
directly within the PLAN state"*, msg[12] *"I should have called `set_plan` to
enter the `SET_PLAN` state before using `send_message_to_user`"*. The phase
boundary renames the tool; nothing in the EXECUTE prompt retracts it.

**Why 3 — the retraction mechanism was deleted and its parameters left behind.**
`build_system_prompt(phase, enabled_tools, disabled_tools, ..., tool_prompts)`
uses **none** of `enabled_tools`, `disabled_tools`, or `tool_prompts`. Commit
`e60f1a270` (2026-05-06) deleted the `# Tool Guidance / ## ENABLED / ## DISABLED`
renderer from the body while keeping all three parameters in the signature, so
every caller kept passing them and nothing failed loudly. The same commit also
reverted `all_tools = ALL_PHASE_TOOLS` back to per-phase lists in
`agent_workflow.py`; before it, `send_message_to_user` was a legal variant of the
EXECUTE union and this failure was structurally impossible. `ALL_PHASE_TOOLS`
survives at `tool_schemas.py:62` with a comment asserting *"The system prompt's
ENABLED/DISABLED sections control which tools the model actually uses"* — a
mechanism that same commit removed — and its only remaining reference is a test.
That stale comment is why the regression stayed invisible for three months.

**Why 4 — routing sent every EXECUTE call to the one provider that does not
enforce the schema.** The failing call logged `claude_auth_present: false`, then
`rose.complete.openai_apikey.fall_through (RoseServerError)`, then waterfall step 1
`anthropic/claude-opus-4.8` **skipped** with
`reason: anthropic_openrouter_response_format_unsupported`, then step 2
`google/gemini-3.1-pro-preview` served it. Our `response_format` json_schema is
rejected by the Anthropic leg and only loosely honoured by Gemini's, so the
`anyOf`/`const` union was advisory. `default_api:send_message_to_user` at 20:34:07
is a Gemini native-function-calling namespace artifact leaking out of a
`response_format` call. **This half is already mitigated at HEAD** by `be1cfd82f`
(2026-08-03) "Preserve native tools through provider fallback", which sends the
AgentAction projection as native tools with `tool_choice="any"` through the
waterfall. The incident predates it by 5 days.

**Why 5 (the amplifier, still live at HEAD) — the retry re-asks byte-identically.**
`agents/helpers/llm.py:2825-2884` catches the `ValidationError` and recursively
re-invokes itself with `messages=messages` unchanged, adding nothing about what
was rejected. Its comment states the assumption: *"A malformed / schema-invalid
structured output is non-deterministic, so re-generate a bounded number of
times"*. That independence assumption does not hold for a **semantic** violation
— a fixed context yields the same wrong name draw after draw (observed 3/3, five
separate times). `agents/loop/run_agent.py:1388-1429` then layers a 3-strike loop
whose only mutation is `bypass_fast_mode_cache_on_llm_retry = True`; the context
is never touched. `MAX_STRUCTURED_PARSE_RETRIES = 2` × 3 loop attempts = up to 9
identical generations per burst, ~15 across the run's five bursts.

**Deepest owned cause:** one tool has two names across a phase boundary, and the
only channel that could reconcile them — the ENABLED/DISABLED section of the
system prompt — was deleted while its call signature was left intact. The blind
parse retry is a second, independent owned defect that converts one bad turn into
a whole-run loss.

**Relationship to `2026-07-16-malformed-structured-output-failed-agent-without-regenerating`:**
that case added this regenerate-in-place retry for **truncated** tool calls
(`{"tool":"think"}` with no args) — a genuinely stochastic serialization artifact
for which blind regeneration is correct. It is `status: fixed` and its repro still
passes. This is **not** a recurrence of it: different generator, different problem
class. What it exposes is a **coverage gap** in that fix — one recovery strategy
applied to every `ValidationError` without discriminating transient-format from
persistent-semantic.

## Solution

**Applied (one line).** `agents/domains/attempt_completion/config.py`
`PLAN_EVENT_MESSAGE` was the empty string, so the execute-boundary tool message
rendered as `"Beginning Execute Phase:"` with nothing after the colon. That
message is the only text the model reads at the exact instant the tool set
changes, and `helpers/llm.py:1099` already recognises it as the execute
boundary. It now retracts the PLAN-only names and states the EXECUTE
replacement.

**Proven by controlled replay of the exact captured request.** All 54 messages,
the response_format, the model and the generation config were held byte-identical
to `dump_id=947970d2345c`; only `messages[15]["content"]` differed between arms.
Against the real `google/gemini-3.1-pro-preview`:

| arm | result |
| --- | --- |
| baseline (as captured) | 4/5 trials emitted `send_message_to_user` → rejected; 1/5 passed |
| with boundary retraction | 5/5 switched to `send_message_to_user_execute_phase`; 4/5 fully passed |

The one remaining reject in the fixed arm invented `trigger_completion` — a name
no prompt teaches. That is why this is `mitigated`, not `fixed`: the taught-name
path is closed, the invented-name path is not.

**Rejected — merging the two tools.** The first proposal was to restore
`ALL_PHASE_TOOLS` so both names validate in EXECUTE. The user rejected it: they
are genuinely different tools. `SendMessageToUserTool` carries
`is_question: bool` (blocks for a reply); `SendMessageToUserExecutePhaseTool`
deliberately has no such field, because EXECUTE has no yield-and-resume
primitive. Merging re-opens
`2026-06-29-execute-phase-has-no-yield-and-resume-on-user-reply-primitive`.
Renaming or deleting the EXECUTE name is separately unsafe: 5 benchmark tasks
list it in `forbidden_tools` (deleting it silently disarms them, rule 25) and it
is embedded in immutable DB message history read by 8+ FE/back-end surfaces.

**Still open (not applied, needs approval):**

1. Feed the rejected name **and the legal names** back into the parse retry.
   `helpers/llm.py:2841` re-invokes itself with `messages=messages` unchanged, so
   an invented name is re-asked identically up to 9× per burst. Repro exists and
   fails: `llm.blackbox.py::test_structured_parse_retry_feeds_validation_error_back_to_model`.
2. Strip provider namespace prefixes (`default_api:`) before validation — that
   alone salvages the research sub-agent and one of the five main-loop failures.
3. `build_system_prompt` still accepts `enabled_tools`/`disabled_tools`/
   `tool_prompts` and uses none of them, and `tool_schemas.py:56-61` still
   describes the deleted ENABLED/DISABLED mechanism as live. Render them or
   delete them; the dead signature is what hid this for three months.

Cemented by `prompt_invariants.blackbox.py::test_plan_only_tool_names_retracted_at_execute_boundary`:
any tool PLAN's prompt names by hand that EXECUTE drops must appear in the
boundary retraction, and the retraction must name a legal EXECUTE replacement.
Verified failing on the pre-fix snapshot
(`PLAN_PHASE_PROMPT names ['send_message_to_user', 'set_plan'] ... never retracts them`)
and passing after. `/deploy` runs this suite via agent coverage.

10k-agent behavior: the fix adds ~90 tokens to one existing tool-result message
per agent that passes through PLAN, once. It does not touch the cached system
prompt prefix, opens no channel, and adds no per-agent work.

## Update 2026-08-04 — controlled replay overturned the prompt diagnosis

Replaying the captured context (dump_id 947970d2345c) through the real
`call_llm_structured_streaming` -> `RoseClient.complete` path at HEAD returns
**6/6 legal tool calls, all served by `anthropic/claude-opus-4.8`** — the model
that was skipped 100% of the time during the incident. Isolating the single
variable, with the boundary message left empty exactly as it failed in prod:

| tool contract | legal |
| --- | --- |
| `response_format` json_schema (incident) | 0/6 — emitted `send_message_to_user` every time |
| native tools + `tool_choice` (HEAD) | 6/6 |

`be1cfd82f` therefore fixed this outright. `AgentAction` yields six real native
tools, so `waterfall_tools` is set and `response_format` is never sent for the
agent loop; the Anthropic `response_format` skip in `waterfall.py:160` is correct
behavior, not a defect. The prompt-retraction fix was implemented, measured
(1/5 baseline -> 5/5 with explicit names, 1/8 with a vague "tools changed"
retraction), then **reverted as redundant** — it also rendered in the user's
timeline via `helpers/llm.py:1362`.

Model attribution across the run: `execute_loop` 74x gemini-3.1-pro + 2x
gpt-5.6-sol, `explore_agent` 134x gemini-3.5-flash, `verifier_execute` 12x
gemini-3.1-pro, `response_schema` 3x gemini-3.5-flash. **Zero Claude calls in 71
minutes.** Only the `default_api:` name prefix is genuinely Gemini-specific.

### What shipped instead

`loop/run_agent.py` — a failed LLM call no longer consumes an iteration.
`iteration += 1` runs before the call, so the explore sub-agent's two failed
parses ate iterations 19 and 20 after 18 turns of real work and it died on
"Reached max iterations (20)". Cemented by
`run_agent.blackbox.py::test_failed_llm_call_does_not_consume_iteration_budget`,
observed failing pre-fix ("only 2 LLM calls made") and passing post-fix.

`providers/rose/pools.py` + `pricing.py` — `rose-1-lite` (which generates the
response schema that defines every run's pass criteria) moved to
`google/gemini-3.6-flash` -> `moonshotai/kimi-k3`. `_POOL_WATERFALLS` was a
hand-copied duplicate of the pool registry behind a "must stay in sync" comment
with nothing enforcing it; it is now derived from `POOL_REGISTRY`, which
revealed `rose-1-mini` had been missing from the duplicate entirely and was
silently getting `None` pricing.

### Still open

- The `price_eur` field that deadlocked the verifier was invented by
  `gemini-3.5-flash` during `response_schema` generation; the user asked for
  "the cheapest options" and never mentioned EUR. Nothing validates generated
  pass criteria against the user's actual request.
- Blind structured-output retry is owned by `7c515ef88` on
  `andyprevalsky/live-at-boot-no-strand`, not yet on main.
- `build_system_prompt` still accepts and ignores `enabled_tools`,
  `disabled_tools`, and `tool_prompts`.

## Human feedback

- Rejected the first proposed fix (merge the two tools via `ALL_PHASE_TOOLS`):
  "they are different tools that expect different args, there should be no
  confusion." Correct — `is_question` exists on the PLAN tool only, and merging
  re-exposes blocking to EXECUTE.
- Pointed out the execute-boundary transition step already exists in the message
  history and asked whether the better fix is simply to make the tool-set change
  explicit there. It was, and it was one line.
- Asked which underlying (non-Rose) model produced the failure. Answer:
  `google/gemini-3.1-pro-preview` served every EXECUTE call in this run;
  `claude_auth_present: false` and the Opus leg was skipped every time with
  `anthropic_openrouter_response_format_unsupported`. Claude never ran.
- Asked for the sub-agent max-iterations failure to be explained rather than
  asserted; on inspection the RCA had wrongly filed it under the same root cause.
  It was `default_api:local_grep`, a different cause in the same class.
- Asked that the proposed fix be run against the local repro before being
  presented as a fix.

## Reusable lesson

When a phase transition renames a tool, the new phase's prompt must retract the
old name explicitly — and never leave `enabled_tools`-style parameters on a
function that no longer renders them, because the dead signature makes the missing
contract invisible.
