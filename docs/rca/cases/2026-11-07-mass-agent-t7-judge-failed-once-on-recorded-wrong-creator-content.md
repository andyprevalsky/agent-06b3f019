---
id: 2026-11-07-mass-agent-t7-judge-failed-once-on-recorded-wrong-creator-content
date: 2026-11-07
title: test-mass-agent-run-0 failed its schema/Task Complete judge once on content that is identical in every replay, including the three runs that passed
surface: agents
component: benchmarks
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: not established; the evaluator t7-schema-task-complete is a single-turn LLM judge over a recorded trajectory whose Michael Lustgarten card says its spawn-agent result researched a different creator
symptoms:
  - "Declared evaluator t7-schema-task-complete failed: FAIL T7: messages[4108]"
  - "contains empty hook_formulas, top_5_performing_pieces_last_90_days, and content_gaps outputs"
tags:
  - mass-agent
  - llm-judge
  - demo-replay
sources:
  - PR #1744
repro: agents/tests/blackbox/background_agents.blackbox.py sequential_foreground_spawns_sharing_a_task_name_return_their_own_results (green 5 of 5, live and replay paths); in all four cloud smoke runs on this branch the driver log holds the same recorded wording ("researches Dr. Molly Maloof, not Michael Lustgarten" 22 times, "Not established for Michael Lustgarten" 24 times) and the judge passed 3 and failed 1
status: open
---

## Problem

The merged-head smoke failed test-mass-agent-run-0's T7 judge while the same task passed on three earlier heads of this branch. The judge's complaint is that one creator card has empty outputs and names research of a different creator.

## Diagnosis

The branch changed foreground spawn bookkeeping keyed by task_name (950e705bb, b65d7927e), and the cached trajectory repeats one task_name twice for 19 agents, so a result swap was the first suspect. It is not what happened: the replayed LLM outputs that state the mismatch come from the recorded July trajectory and are byte-for-byte present in all four runs' driver logs (counts above), so the wrong-creator pairing is recorded data, and only the judge's verdict varied (6 of 317 historical attempts failed a T7 check). A direct blackbox case now pins that two sequential foreground spawns sharing a task_name each get their own result and posted rows. The judge variance itself was not reproduced; a local rerun of the unchanged task is pending, so the cause stays open.

## Solution

None to the product. The regression above stays as the guard for the suspected mechanism. Recorded-data quality (a creator card with empty outputs) is a candidate for a fixture review, which needs approval because it changes a benchmark definition.

## Human feedback

The deploy coordinator asked for the replay path to be tested directly before calling this a flake.

## Reusable lesson

Before blaming a code path for a judge miss, diff the replayed content across passing and failing runs: identical content means the variance is in the judge.
