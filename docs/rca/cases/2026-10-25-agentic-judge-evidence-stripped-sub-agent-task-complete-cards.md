---
id: 2026-10-25-agentic-judge-evidence-stripped-sub-agent-task-complete-cards
date: 2026-10-25
title: The agentic judge's evidence showed every sub-agent Task Complete card as empty and lacked the typed T7 fields
surface: agents
component: benchmark-judge-evidence
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/benchmarks/semantic_evaluator_evidence.py — _evidence_rows_from_messages dropped metadata.completionSummary (allowlist) and rendered only the root card, and build_agentic_evidence passed the raw _benchmark as benchmark_state instead of the compact typed view
symptoms:
  - "First-level Task Complete cards have populated 14-field schemas but empty outputs"
  - "Declared evaluator t7-schema-task-complete failed: FAIL (T7)"
  - "evidence_mode: agentic_llm_judge"
  - "Failed to create code session (provider=codex): HTTP 500: {\"error\":\"fetch failed\"}"
tags:
  - llm-judge
  - agentic-judge
  - evidence-builder
  - mass-agent
  - completion-summary
sources:
  - agent 9ffb8100-e09a-4d74-b8e0-17be8c33a19f
  - fleet run 20261025-115241-2426790
  - agent a215930e-805d-4e50-8fa5-99e878190b00
  - commit 0660bb87e
  - commit 7202b10ac
repro: agents/tests/blackbox/benchmark.blackbox.py::test_agentic_judge_evidence_shows_each_sub_agent_task_complete_card
status: fixed
---

## Problem

On 323adac65, test-mass-agent-run-0 had 50/50 GPs with 14-field outputs, and the static
check t7-schema-complete-outputs passed. The T7 judge, running in agentic mode because the
single-turn prompt overflowed, still failed: "First-level Task Complete cards have populated
14-field schemas but empty outputs; verified for direct child db85901b". The run record shows
14 outputs on that card. In the full3 run, the same judge item passed 44 incomplete outputs.

## Diagnosis

Rebuilding the agentic `benchmark_evidence.json` from the run record with the production
builder (67 MB) shows that all 51 "✅ Task Complete" rows have empty text and no
`completionSummary`:
- The metadata allowlist drops `completionSummary`, and only the root card was re-rendered.
- The agentic `benchmark_state` was the raw `_benchmark`. The single-turn path swaps in the
  compact typed view (`completion_outputs_count`, `completion_is_ablated`), which the T7
  prompt tells the judge to use.

So the evidence showed every GP card as empty. The only true copy sat in raw tree messages
buried in the same file, which is why verdicts flipped both ways on that rubric item.

## Solution

- Every FINISHED `completion_summary` row renders its own card (`{summary, outputs}`, as an
  ASSISTANT `final_completion` row). The duplicate trailing root card is removed.
- The agentic `benchmark_state` uses `_compact_benchmark_state_for_judge`, the same view as
  single-turn.
- Agentic verdicts record `judge_audit` (judge agent id, evidence sha256, byte count and
  storage path) in the evaluator result.
- On the real run.json, all 50 GP cards show 14 outputs and the typed `first_level_gps` show
  50/50 at `completion_outputs_count=14`. The file shrank from 67 MB to 31 MB.
- Judge replays (production `_call_declared_agentic_llm_judge`, local stack):
  - fixed evidence: 3/3 PASS, each citing the typed fields;
  - old 67 MB evidence: 3/3 could not start locally, because code-session creation returned
    HTTP 500 "fetch failed". The old FAIL rests on the cloud verdict plus the byte-level
    evidence above.
- The regression is red on 323adac65 and green 5/5. The benchmark domain passes. The catalog
  test now lists t7-schema-complete-outputs (missed in MA5).
- No evaluator was weakened. Output completeness stays deterministic through
  t7-schema-complete-outputs.

## Human feedback

The parent asked to reproduce what the judge saw, fix the first-bad boundary, keep every
failing condition failing, and retain judge evidence for audit.

## Reusable lesson

Before trusting or blaming an LLM judge, rebuild its exact evidence file and check that the facts it is asked about (typed fields, every agent's card) are actually present in it.
