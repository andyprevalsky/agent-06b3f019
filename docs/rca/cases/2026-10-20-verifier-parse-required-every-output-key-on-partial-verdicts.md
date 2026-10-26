---
id: 2026-10-20-verifier-parse-required-every-output-key-on-partial-verdicts
date: 2026-10-20
title: Verifier parse rejected valid partial verdicts that omitted an ungrounded required output field
surface: agents
component: helpers-llm-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py _call_llm_verifier validated every verdict against _build_verifier_response_model, which requires each schema-required output key even when score < 1.0
symptoms:
  - 'validation error(s): output.description: Field required'
  - 'Verifier call failed, retrying'
  - 'Progress check failed: 1 validation error(s)'
  - 'Codex Failed'
  - 'Verifier unavailable after 3 consecutive failures'
tags:
  - verifier
  - structured-output
  - response-schema
  - pydantic
  - openai-strict
  - code-agent
  - codex
  - partial-verdict
sources:
  - agent 9698df4f-0492-415d-962d-a0dbb3b0bf92
  - plan:.context/rose-real-recordings/run3/logs/worker-stdout.log
  - commit 15fb6a00a
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py test_run_verifier_partial_verdict_missing_required_field_reaches_parent; agents/tests/blackbox/llm.blackbox.py test_call_llm_verifier_required_output_keys_bind_only_completion_verdicts
status: fixed
---

## Problem

In the 2026-10-20 local user-UI recording (run3, branch at 7e1577812), the root
agent `9698df4f-0492-415d-962d-a0dbb3b0bf92` ("Make me a game") spawned a Codex
code agent with output schema `game_file` (file_pointer, required), `view_name`
(str, optional) and `description` (str, required). The code agent built and
published the game and exited 0. Its final message named the file and view but
did not describe the game or controls.

The code-agent verifier (`verifier_claude_code`, `gpt-6-sol-gpt`, pool
`gpt-token`) answered six times (one call plus five retries, 11:52:49–11:53:58Z)
with the same verdict: score 0.5, `output` holding `game_file` and `view_name`,
and reasoning that the required description was not grounded and naming the
evidence to produce. Each answer was rejected with
`1 validation error(s): output.description: Field required`. The activity then
logged `Failed to check progress` and returned its 0.5 placeholder. The parent
received `❌ FAILED`, Outcome `Progress check failed: 1 validation error(s):
output.description: Field required`, and `structured_response: null`. It read
that as an output-validation failure and started a second three-minute code
sandbox. The verifier's actual feedback never reached any agent.

## Diagnosis

Critical path: execute loop `spawn_agent(type=code, output_schema)` →
`spawn_claude_code_activity` → Codex session → output extraction →
`_run_verifier` → `check_progress` → `_call_llm_verifier` → Rose →
verdict JSON → `response_model.model_validate` → `_run_verifier` result →
parent tool message.

The recorded LLM dumps show the data is correct through the verifier's JSON. It
first goes wrong at `_call_llm_verifier`. `_build_verifier_response_model` marks
every schema-required output field as required. The verifier rubric defines
0.5 and 0.0 as verdicts in which a required field cannot be grounded. It forbids
inventing such a value and says to omit keys without evidence. `check_progress`
also documents (C2) that partial output is always returned. Valid verdicts in
those bands were therefore unrepresentable. The parse raised a `ValidationError`.
The retry loop treated that as malformed output and regenerated the same
verdict until it exhausted its retries.

What made this possible: OpenAI strict mode had hidden the contradiction. When
every field is required, strict mode makes the provider emit every key, so a
partial verdict fills the key with a placeholder. Since `15fb6a00a` (optional
output fields), an optional or open field turns strict mode off
(`"strict": false` in all six dumps). The provider then lets the model follow
the prompt and omit the field. No test covered a non-strict partial verdict
with a missing required key. The C2 test used a fully populated partial output.

The next rung, "the verifier output is a typed schema", is a deliberate design
choice. Stop there. The fix belongs at the parse contract.

Sibling failures from the same parse:

- `verifier_execute`: `run_agent` returns `Verifier unavailable after 3
  consecutive failures` once three such placeholders arrive in a row.
- The browser and post-DAG verifiers.

Each one also spends five extra verifier calls.

Archive searches: the literal error string and a symptom phrasing ("verifier
partial output omitted required field parse rejected retries exhausted").
Related cases: `2026-09-04-disabled-verifier-counted-any-file-as-schema-complete`
(same completeness predicate, different path) and
`2026-10-02-payment-card-shadow-index-bypassed-semantic-fill`. Neither is a
recurrence at this boundary. This case is novel.

## Solution

`_call_llm_verifier` now picks the parse model from the verdict.

- **Score ≥ 1.0, or unscored/non-numeric:** the verdict is still checked against
  the unchanged completion contract. Every required key must be present at every
  nesting level, so a pass that omits a field is still rejected and regenerated.
- **Score below 1.0:** the verdict is parsed with
  `_build_verifier_response_model(schema, completion_verdict=False)`. That
  builder keeps the same annotations and bounds but lets required keys be
  absent. Present values are still typed, and explicit nulls are still
  rejected unless nullable.

The provider-facing response schema, prompt and strict flag are unchanged.
Nothing that failed before now passes: a partial verdict still scores below 1.0.
The difference is that its real reasoning and partial `structured_response`
reach the agent after one call instead of six. This prevents the code-agent,
execute, browser and post-DAG siblings because they all share this parser.

Regressions:

- `spawn_claude_code_agent` replays all six recorded verdicts through the real
  `check_progress` and `_run_verifier`.
- `llm` pins the contract: partial top-level and nested omissions are accepted,
  1.0 omissions and mistyped or null values are rejected, and the request schema
  is identical across calls.

Golden reference: `claude-code-src/src/tools/AgentTool/built-in/verificationAgent.ts:119-129`
makes PARTIAL and FAIL first-class verdicts that report what could not be
verified. `codex/codex-rs/core/src/client.rs:1036-1040` enforces output schemas
through the provider's strict flag instead of re-rejecting provider output
locally. The fix converges on both.

At 10k agents: this is per-call CPU only (one extra `create_model` for
sub-1.0 verdicts). It adds no channel, query, lock or shared state, and it
removes up to five redundant LLM calls per partial verdict.

## Human feedback

None recorded.

## Reusable lesson

Validate a judge's output against the contract implied by its own verdict: required output keys bind a completion claim, never a partial verdict that the rubric defines by their absence.
