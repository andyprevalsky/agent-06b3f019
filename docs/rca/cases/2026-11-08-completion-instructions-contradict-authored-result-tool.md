---
id: 2026-11-08-completion-instructions-contradict-authored-result-tool
date: 2026-11-08
title: Completion instructions contradicted the authored-result tool argument
surface: agents
component: completion-prompt-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/prompts.py format_required_output_schema_user_message
symptoms:
  - "which takes no arguments"
  - "not passed to it"
  - "Prompt denies the supported authored-result argument"
tags:
  - completion
  - prompt-contract
  - authored-result
sources:
  - PR #1682
  - commit 15fb6a00aa
  - commit 48e2ddd0db
repro: agents/tests/blackbox/prompts.blackbox.py::test_completion_prompt_matches_authored_result_tool_contract
status: open
---

## Problem

The schema-bearing completion prompt said `attempt_completion` takes no arguments and that output fields are not passed to it. The actual tool supports an optional `result`, and the agent loop carries this authored work to the verifier. A registered cross-module regression failed on the contradictory prompt before the repair.

During separate investigation of a retained mass-agent recording, the current verifier returned `task_completed=false` and score 0.5: the producer had not authored the requested opportunities and engagement approach. Its completion result only referred to prior tool outputs. The verifier's own inferred recommendations were not producer work. This observation does not prove that the prompt contradiction caused that historical omission, and this repair does not qualify that fixture.

## Diagnosis

The formatter restriction dates to commit 15fb6a00aa; the optional authored-result argument was added in 48e2ddd0db. The duplicated parameter description drifted from `AttemptCompletionTool.result`. `build_system_prompt` includes the formatter text, while `_with_authored_result` in `agents/loop/run_agent.py` forwards actual completion content to verification. The contradiction predates the current deploy source; it is not introduced by PR1682, but remains an owned defect.

The deterministic regression checks the real tool schema, constructs a valid authored result, and checks the generated prompt. It failed with `Prompt denies the supported authored-result argument` against the original formatter. The existing run-agent authored-result regression independently covers delivery to the verifier. Evidence and full logs are retained under `.context/deploy-session/mass-fixture-existing-517/producer-contract-validation/`.

## Solution

Remove the two incorrect parameter restrictions, leaving evidence requirements, optional output fields, extraction policy, tool schema, verifier rubric and timeouts unchanged. The tool schema remains authoritative for arguments. The registered prompt test passes; five focused repetitions and full prompts, tool-schemas and run-agent suites passed, including 103 run-agent cases.

This prevents the same contradiction for every schema-bearing task, without task-specific answers or additional model operations. At 10,000 agents the prompt is shorter and no new calls are introduced. A deeper attempt to derive all completion policy from the argument schema would lose evidence and completion semantics that the schema does not encode; that broader rewrite is not justified by this defect. Claude Code (`src/utils/api.ts:156`) derives tool inputs from schemas. Hermes (`agent/prompt_builder.py:202,563`) defers parameter scope to schemas, while OpenClaw (`src/agents/system-prompt.ts:549,656`) uses schema-backed decisions and valid argument examples. These support the narrow principle of removing contradictory restrictions, not a general ban on duplicate argument guidance. Independent completion policy and consistent examples remain legitimate.

The case remains open until actual producer work, strict verifier acceptance and full fixture qualification resolve the separate observed benchmark failure. Neither local regression results nor historical scores establish that outcome.

## Human feedback

The user authorized completing deployment and preservation-safe work without repeated approval requests. Protected histories, failed caches and original negative results must remain intact. No human supplied missing task answers or authorized fabricating successful verifier results.

## Reusable lesson

When a tool gains an argument, test generated instructions against the actual tool contract and remove stale duplicate parameter claims instead of adding competing instructions.
