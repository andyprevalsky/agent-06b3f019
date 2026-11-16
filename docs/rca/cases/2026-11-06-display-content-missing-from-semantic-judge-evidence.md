---
id: 2026-11-06-display-content-missing-from-semantic-judge-evidence
date: 2026-11-06
title: Semantic judges never saw what the agent displayed to the user, so a correct inline answer card failed the lease recall judge
surface: agents
component: benchmark-evaluator-evidence
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _run_declared_evaluators — hydrated Agent Display content only for tasks with display static checks, and benchmarks/semantic_evaluator_evidence.py never rendered displayed items, so judge-only tasks saw the bare "Displayed 1 item(s) inline for the user; text/html." stub
symptoms:
  - "The display tool merely confirms that an HTML item was displayed without exposing its contents"
  - "its content is absent from the evidence, so it cannot establish that the missing terms were presented to the user"
  - "Displayed 1 item(s) inline for the user; text/html."
  - "the first missing final-answer requirement is the written-notice qualification"
tags:
  - benchmark-evaluator
  - judge-evidence
  - agent-display
  - google-drive-lease-recall
  - descend
sources:
  - task google-drive-lease-recall
  - agent 987ebdab-28a8-46e7-99e1-c291ece49056
  - agent 7f606664-8577-4a19-8ff0-133eb7740e1c
  - agent 7652dd95-c458-4a7b-bc5b-762ff4aaa227
  - agent 75595929-c232-44a4-aefa-7fee12cc3f35
  - fleet run 20261106-110445-4093376
repro: agents/tests/blackbox/benchmark.blackbox.py::test_declared_judge_sees_the_item_displayed_to_the_user
status: fixed
---

## Problem

/descend run descend-failed-neverrun-20261106, epoch 4 (job r001-j0007, agent
987ebdab, fleet run 20261106-110445-4093376): `google-drive-lease-recall`
FAILED `google-drive-recall-semantics` although the agent answered correctly.
It grepped Drive, read the current 412 Juniper Lane lease, and showed the user an
inline HTML card (`display`) with "Move-out notice — At least 60 days — Written
notice, by email to the property manager and by certified mail" and "Pets
allowed? — Yes, one cat — $500 refundable pet deposit required. Dogs are not
permitted." Its Task Complete card used a runtime response schema
(`notice_period_days: 60`, `pets_allowed: true`). The judge
(`gpt-6.1-sol-foundry`) said: "The display tool merely confirms that an HTML item
was displayed without exposing its contents, so it cannot establish that the
missing details were delivered."

The same task PASSED in epoch 3 (agent 7f606664) with the same lossy card shape
and the same `display` call: that judge (`claude-opus-5-5-claude`) accepted
`notice_days: 60` / `pets_allowed: true` "as the response schema requires a
boolean". The verdict depended on which judge model served, because neither
judge could see the answer the user was actually shown. Andy's Claude token was
rate-limited (Anthropic 429, reset 2026-12-01) between the two runs, so epoch 4
fell to the Foundry GPT judge.

## Diagnosis

Critical path: agent `display` tool → backend posts an inline media row
(`metadata.source == "display"`, file pointer to `/usercontent/display/…html`)
plus a TOOL row "Displayed 1 item(s) inline for the user; text/html." →
`_run_declared_evaluators` → `_declared_evaluator_evidence` /
`build_single_turn_evidence` → judge prompt.

- The archived LLM trace for agent 987ebdab (R2 `provider/fast-cache/llm/086d860f…`)
  holds the `display` tool call arguments: the HTML card above, verbatim
  (`agents/benchmarks/fixtures/display_judge_evidence/google_drive_lease_recall_e4_r001_j0007.html`).
  The data was correct at the sink the user sees.
- `_run_declared_evaluators` called `_hydrate_display_artifacts` only when the
  task declared `display_media_shown` / `display_artifact_figures` static
  checks. `google-drive-lease-recall` has none, so `_benchmark.display_artifacts`
  was never filled.
- `build_single_turn_evidence` renders the Task Complete card from
  `metadata.completionSummary` (the 2026-10-20 fix) but had no rendering for
  displayed items; the display rows reach the judge only as the stub text.

Deepest owned cause: the evaluator evidence contract treated the completion card
as the only metadata-only answer surface. Displayed items are user-visible answer
content in the FE, so a judge reading only the stub disagrees with the
authoritative outcome (descend issue class: Faulty Evaluator).

Archive search: `display judge evidence displayed item final answer evaluator
missing` and `completion card final answer judge single_turn evidence`. Relative
of 2026-10-20-polar-evidence-builder-dropped-completion-summary-card (same
problem class: a metadata-only answer row not rendered for the judge); that fix
covered only `completion_summary`, so this is the same lesson missed for Agent
Display.

Local exact-task proof (`scripts/run-bench --local google-drive-lease-recall`,
Claude rate-limited so the judge is `gpt-6.1-sol-foundry` as in the cloud):

- Buggy (base 8d8d6a316d): agent 7652dd95, FAIL — "The display tool only
  acknowledges rendering HTML; its content is absent from the evidence, so it
  cannot establish that the missing terms were presented to the user."
  Run record `agents/benchmarks/runs/20261106_115359_e084cb3f-…_google-drive-lease-recall.json`,
  FE https://www.roselabs.ai/?agent-id=7652dd95-c458-4a7b-bc5b-762ff4aaa227
- Fixed (same command, task definition unchanged): agent 75595929, PASS — the
  same `gpt-6.1-sol-foundry` judge: "The user-visible final HTML reports all four
  correctly." Run record
  `agents/benchmarks/runs/20261106_115804_59c29e99-…_google-drive-lease-recall.json`,
  FE https://www.roselabs.ai/?agent-id=75595929-c232-44a4-aefa-7fee12cc3f35

## Solution

- `_run_declared_evaluators` hydrates Agent Display content whenever the task has
  a semantic judge (`single_turn_llm_judge`, `agentic_llm_judge`, `polar`), not
  only for display static checks. It reuses the existing
  `display_check.hydrate_display_artifacts` (usercontent fetch, bundle text,
  raster vision transcript).
- `semantic_evaluator_evidence._displayed_item_rows` renders each hydrated item
  as an ASSISTANT row with `evidence_type: displayed_to_user`, bounded by the
  runtime per-result cap (`hard_cap_tool_result_text`); a fetch failure renders
  as an explicit "content unavailable" row. Both the single-turn and agentic
  builders include it.
- `_compact_benchmark_state_for_judge` keeps display artifact metadata but drops
  its raw `text`, so the judge sees the content once.

Regression: `test_declared_judge_sees_the_item_displayed_to_the_user` replays the
failing run's rows and real HTML through `_run_declared_evaluators`. Pre-fix:
`displayed item was never fetched for the judge: []`. Post-fix: passes (5/5).
Registered in the benchmark blackbox suite (`run_all_tests`), which `/deploy`
runs in agents coverage.

Not changed: the task, its evaluators and criteria, the judge prompt and the
response schema. The Polar evaluator (`polar_evaluator.py`, an isolated
Odysseys-faithful path) also does not render displayed items; left as a
follow-up.

10k agents: one extra usercontent GET per displayed item, per judged benchmark
run, at evaluation time only; no runtime or per-agent hot-path cost.

## Human feedback

None recorded for this case. The standing alignment from 2026-10-21 applies:
final-answer/completion-card evidence belongs in the evaluator input "across ALL
benchmarks by default".

## Reusable lesson

A semantic judge must see every surface the user was shown — the Task Complete
card AND Agent Display items — or its verdict depends on which judge model guesses
generously.
