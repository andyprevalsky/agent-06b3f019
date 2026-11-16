---
id: 2026-11-06-valid-code-agent-handoff-rejudged-by-hidden-non-empty-rule
date: 2026-11-06
title: A schema-valid code-agent handoff was re-judged by a hidden required-means-non-empty rule, labelled UNVERIFIED and left without judge evidence
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _handoff_result — after _read_handoff accepted the handoff against handoff_json_schema, it re-classified the same result with _disabled_verifier_outcome, whose _declared_field_satisfied rejects a present empty value for a required field (open_issues == []) although that rule is absent from the JSON Schema the code agent was given; outcome "unverified" (score 0.5) skipped the `if complete:` judge-evidence persistence
symptoms:
  - "Declared evaluator process-native-trace failed: Process Bench: need one unambiguous fixture session with native action/result evidence"
  - "[ClaudeCode] Verifier skipped; returning handoff exit_code=0 handoff_status=present handoff_valid=true outcome=unverified score=0.5"
  - "**Status**: ⚠️ UNVERIFIED **Outcome**: Code-agent verifier off (provider=claude, exit_code=0, artifacts=0). Handoff from /home/user/.rose/handoff.json, validated against the declared output schema"
  - no code_agent_sdk_events message anywhere in the agent tree although the transcript shows every process-fixture.py command [Bash ✓]
  - handoff with a required list field answered [] (open_issues, blockers, failed_prerequisites, normalized_quotes)
tags:
  - process-bench
  - judge-evidence
  - code-agent
  - handoff
  - output-schema
  - verifier-off
  - descend
sources:
  - benchmark run descend-failed-neverrun-20261106 cluster H-21 (campaign campaign-20261106-125707-4128298, source a17dbe5aec)
  - fleet run 20261106-134902-1937137, process-expense-reimbursement r002-j0032, agent 17bbefa2-d9ab-4573-8d08-8c7fc89ed161, code task 70205ca7-8fa1-4a03-a068-142e845dd16b
  - fleet run 20261106-125725-4136748 (contrast r001-j0012, agent 61631f38) — no open_issues field, outcome=complete, evidence persisted
  - fleet run 20261106-125725-4136764 (sibling process-investor-outreach, blockers []), fleet run 20261106-132829-937860 (process-vendor-procurement, normalized_quotes []), fleet run 20261106-134442-1686902 (process-contract-renewal, failed_prerequisites []) — all handoff_valid=true outcome=unverified
  - commit f603c23f2e (handoff contract, 2026-10-24), 1c78bf3557 (unverified outcome, 2026-10-23)
  - commit on branch rca/h-21-20261106 (this fix, based on rca/h-18-20261106 393a08a7fc)
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_valid_handoff_with_empty_required_list_is_complete_and_keeps_process_evidence (fixture agents/tests/blackbox/fixtures/spawn_claude_code_agent/process-expense-reimbursement-valid-handoff-empty-required-list.json)
status: open
---

## Problem

process-expense-reimbursement r002-j0032 ended COMPLETED but FAILED
`process-native-trace`: "need one unambiguous fixture session with native
action/result evidence". The code agent ran all six applicable
`process-fixture.py` actions (collect-receipts, duplicate-check,
approve-exception, post-ledger, pay-employee, reconcile; transcript
14:04:27–14:04:51, every one `[Bash ✓]`) and wrote a handoff. The worker logged
`[ClaudeCode] Verifier skipped; returning handoff exit_code=0
handoff_status=present handoff_valid=true outcome=unverified score=0.5`, the
parent saw `⚠️ UNVERIFIED`, and no `code_agent_sdk_events` row exists in the
tree, so process_bench found zero fixture sessions.

The captured handoff is valid against the declared schema and answers the
required `open_issues: list[str]` with `[]`. The r001-j0012 copy of the same task
declared no `open_issues` field, logged `outcome=complete`, and persisted its
SDK evidence.

## Diagnosis

Archive searches: `"Verifier skipped returning handoff outcome unverified
handoff_valid judge evidence code_agent_sdk_events not persisted"` and
`"required empty list satisfied declared field empty value explicitly allows
empty maxItems 0 schema valid handoff rejected"`, plus a grep for
`need one unambiguous fixture session`. Relatives, not recurrences:
`2026-10-23-disabled-verifier-labelled-unverified-fields-failed` (introduced the
unverified label for mechanically extracted evidence),
`2026-09-04-disabled-verifier-counted-any-file-as-schema-complete` (introduced
the non-empty rule and the success-only evidence gate), and H-18
`2026-11-06-code-agent-judge-evidence-counted-raw-stream-and-cut-tail` (same
evaluator, different boundary: evidence count/paging).

Causal chain: `_read_handoff` validates the handoff with
`handoff_json_schema(output_schema)`, the same JSON Schema appended to the code
agent's task. That schema adds `minItems`/`minLength` only when the parent
declared them, so `[]` is valid. `_handoff_result` then re-classified the same
result with `_disabled_verifier_outcome`. Its `_declared_field_satisfied`
rejects a present empty value for a required field unless `maxItems == 0`.
On the captured fixture this returns `('unverified', ['open_issues'])`; with
`open_issues: ["x"]` it returns `complete`. `complete` was False, the score was
0.5, and the `if complete:` branch never called
`_persist_code_agent_judge_evidence`.

Why the evidence gate exists: the 2026-09-04 case gated judge evidence on
process success so that files left by a failed process do not become
successful code-agent steps for declared judges. The gate is correct; it was
fed a false outcome.

Step 5a: the non-empty rule belongs to mechanical extraction, where an empty
extracted value means "no evidence found". The handoff path (f603c23f2e,
2026-10-24) reused that predicate for an agent-authored result that already
passed its own schema. One result therefore had two contracts, and the code
agent could see only the looser one. The next rung would encode
required-means-non-empty into every model-facing schema. That would force an
agent to invent entries for an honest "no open issues". It would also change
LLM-visible contract text, so it was not pursued.

Same-campaign siblings with `handoff_valid=true outcome=unverified`:
process-investor-outreach (`blockers: []`), process-vendor-procurement
(`normalized_quotes: []`) and process-contract-renewal
(`failed_prerequisites: []`). Their final failures (count mismatch from another
session and two timeouts) are not attributed to this cause here.

Local repro (buggy code, rca/h-18-20261106 393a08a7fc + the new test):
`cd agents && source venv/bin/activate && python <runner> test_valid_handoff_with_empty_required_list_is_complete_and_keeps_process_evidence`
→ `assert score == 1.0` fails with `Code-agent verifier off (provider=claude,
exit_code=0, artifacts=0). Handoff from /home/user/.rose/handoff.json,
validated against the declared output schema: ...`, the production text.

## Solution

`_handoff_result` takes the outcome from the handoff contract alone. A
schema-valid handoff from a session with a success signal is complete. A
session without a success signal is failed. An absent, unreadable or
schema-violating handoff is not complete, and the log names it
`invalid_handoff`. The redundant re-judgement and its unreachable
`incomplete` text branch were deleted. The extraction predicate and the
success-only evidence gate are unchanged for the non-handoff path.

The regression replays the verbatim captured schema and handoff through
`_run_verifier` with the real producer, repository and process_bench checker.
It asserts score 1.0, the returned structured result, and that the persisted
`code_agent_sdk_events` rows pass `check_process_trace` for
process-expense-reimbursement. It also pins that exit 1 with the same handoff
and a missing handoff with exit 0 both stay at 0.5 and persist no evidence. It
failed before the fix at `assert score == 1.0` and passed after (5/5
consecutive), and the full `spawn-claude-code-agent` blackbox domain passes
(169 tests).

Siblings prevented: any declared required list or string that is legitimately
empty in a valid handoff (the three same-campaign process tasks above).

Also observed, not fixed here: `e2bCloseSession.ts` extracts output with
`find /home/user/output -maxdepth 1`. The handoff's `evidence` file pointer under
`/home/user/output/process-artifacts/` was therefore never extracted
(`artifacts=0`). That did not cause this failure, because process_bench reads
SDK evidence.

10k agents: pure per-call classification with no I/O. The evidence rows already
written for complete sessions are unchanged in count and size per session.

Golden reference: not applicable (no approval-gated hunk; the deploy
agent-behavior, prompt and trajectory-injection guards report no changes). The
analog is `claude-code-src/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:143`:
structured output is accepted when it validates against the declared JSON Schema
alone. This fix converges on that rule.

Outcome proof is pending: the exact benchmark was not rerun in this RCA. The
descend parent's unchanged cloud rerun of process-expense-reimbursement
supplies it.

## Human feedback

None recorded.

## Reusable lesson

Validate an agent-authored result against exactly the schema the agent was shown; never re-judge it with a stricter hidden predicate built for mechanically extracted evidence.
