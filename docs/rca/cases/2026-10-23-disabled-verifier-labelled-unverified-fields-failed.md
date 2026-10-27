---
id: 2026-10-23-disabled-verifier-labelled-unverified-fields-failed
date: 2026-10-23
title: Disabled code-agent verifier labelled a completed session FAILED for fields nothing checked
surface: agents
component: spawn-claude-code-agent-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py:_run_verifier (ROSE_DISABLE_CODE_AGENT_VERIFIER branch) and the spawn_claude_code_activity build_context_summary call — any required non-file field without a mechanical extractor made the result "❌ FAILED ... Required output artifacts were not completely extracted - incomplete"
symptoms:
  - "Required output artifacts were not completely extracted - incomplete."
  - "Returning session result as-is (provider=claude, exit_code=0, artifacts=1). Required output artifacts were not completely extracted - incomplete."
  - Verifier skipped via ROSE_DISABLE_CODE_AGENT_VERIFIER exit_code=0 has_artifacts=false has_success_signal=true
  - successful Claude Code session (exit 0, output file written) reported "**Status**: ❌ FAILED" / Task Incomplete to the root agent
tags:
  - claude-code
  - codex
  - verifier
  - output-schema
  - tool-result-label
  - claude-code-agent
sources:
  - benchmark run descend-full69-20261023 claude-code-agent r002-j0010, r003-j0019, r005-j0037 and the two passing copies
  - agent d5def233-b4d0-4b2d-8db7-0abf07def3be task c07d4462-4665-4f92-808f-5de722a52ef6 (fleet run 20261023-071845-27493)
  - fleet run 20261023-071845-27493
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py:test_disabled_verifier_reports_successful_session_truthfully
status: open
---

## Problem

Benchmark task: `claude-code-agent` (all five copies of descend run
descend-full69-20261023 on feat/rose-user-ui 8b69d3760). Benchmarks run with
`ROSE_DISABLE_CODE_AGENT_VERIFIER=1`. A Claude Code session that exited 0, wrote
`/home/user/output/collatz.py` and returned the full program, stdout, sequence
and step count was reported to the root LLM as:

`**Status**: ❌ FAILED` / `Code-agent verifier disabled (ROSE_DISABLE_CODE_AGENT_VERIFIER).
Returning session result as-is (provider=claude, exit_code=0, artifacts=1).
Required output artifacts were not completely extracted - incomplete.`

Worker log (task c07d4462): `Session closed output_files=1` then `Verifier
skipped via ROSE_DISABLE_CODE_AGENT_VERIFIER exit_code=0 has_artifacts=false
has_success_signal=true has_structured_response=true score=0.5`. The root's
schema for that spawn declared a required `status` string plus six optional
fields; the third spawn (`collatz_card`) declared a required `display_receipt`.
The label was not causal in r002-j0010 (the root still used the output), but it
is a false, LLM-visible failure claim.

## Diagnosis

Archive searches: `"Required output artifacts were not completely extracted
incomplete ROSE_DISABLE_CODE_AGENT_VERIFIER"` and `"verifier disabled
successful code session labelled failed structured response schema fields not
extracted"`, plus `grep -ril "not completely extracted"`. Closest hit:
`2026-09-04-disabled-verifier-counted-any-file-as-schema-complete` (fixed). This
case is a relative, not a recurrence: that fix correctly stopped the disabled
branch from claiming success (score 1.0) without every declared field, and it
remains intact here. It left one predicate driving both the score and the text.

Causal chain: with the verifier disabled, `_structured_response_from_code_evidence`
can fill only file pointers and a few stdout/sequence/step fields. A required
free-form field such as `status` or `display_receipt` has no extractor, so
`_structured_response_satisfies_declared_schema` is False, `has_artifacts` is
False, and the text appends "Required output artifacts were not completely
extracted - incomplete". `success = score >= 1.0` is False, so
`build_context_summary` prints `❌ FAILED`. Nothing judged that field: the
artifacts (one file, no file field declared) were in fact extracted.

Step 5a: why was this possible? The disabled branch had two outcomes (complete,
not complete) for three real states. "Verifier did not judge this field" was
collapsed into "the session failed". Next rung: the sandbox never asks the CLI
for native structured output (`--json-schema` / `initialize.jsonSchema`,
`claude-code-src/src/cli/print.ts:4450`; ws-server already forwards
`structured_output`), so free-form fields cannot be filled mechanically at all.
That rung is a capability/template change (E2B template rebuild shared with
prod, Codex parity, agent-visible behavior) and is recorded as follow-up, not
this fix.

Production: Fly app navi-whisper-lux has no ROSE_DISABLE_CODE_AGENT_VERIFIER
secret (75 secrets listed 2026-10-23) and no machine env entry. Only
`scripts/cloudbench_catalog.py` and local benchmark setup set it, so production
uses the LLM verifier and does not reach this branch.

## Solution

`_disabled_verifier_outcome` classifies an unjudged session as `failed` (no
success signal), `incomplete` (a declared file field was not extracted),
`unverified` (success signal, files present, some declared fields have no
mechanical evidence) or `complete`. Score is unchanged, so success still
requires every declared field (the 2026-09-04 contract). The text now states
the truth per state. For `unverified` the status line becomes
`⚠️ UNVERIFIED` and the reasoning lists the unchecked fields and points the
parent at the session output. The per-field predicate `_declared_field_satisfied`
is shared with the existing whole-schema predicate. The regression drives
`spawn_claude_code_activity` with the captured schema and session result and
also pins that a missing required file and a failed process still report
FAILED. Per-agent pure computation, no I/O: no change at 10k agents.

Golden reference: `claude-code-src/src/tools/AgentTool/AgentTool.tsx:1298`
returns a completed subagent's content to the parent without its own pass/fail
verdict; the parent judges. This fix converges: an unjudged result no longer
carries a fabricated FAILED verdict.

Outcome proof is pending: the label does not decide the benchmark verdict, and
the parent's cloud rerun of claude-code-agent supplies the outcome evidence.

## Human feedback

None recorded.

## Reusable lesson

When a check is skipped, report its fields as unverified; never turn "nothing checked this" into a failure claim the parent agent will act on.
