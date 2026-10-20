---
id: 2026-10-20-polar-evidence-builder-dropped-completion-summary-card
date: 2026-10-20
title: Polar judge never saw the final answer because its action history dropped the completion_summary card
surface: agents
component: polar-evaluator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/polar_evaluator.py build_polar_trajectory — read only message text, so the FINISHED completion_summary row (empty text, answer in metadata.completionSummary) rendered as a bare "Action: completion_summary | status=FINISHED"
symptoms:
  - "no final user-facing summary text is present"
  - "ends with verifier and completion actions"
  - "Declared evaluator odysseys-rubrics-perfect failed: polar perfect-score failed"
  - "Action: completion_summary | status=FINISHED"
tags:
  - polar-bench
  - odysseys
  - benchmark-evaluator
  - completion-summary
  - judge-evidence
sources:
  - agent 25c02595-b608-499a-b2fd-34682ff616bd
  - hub run 20261020-043620-26478-m8aabb3992195
  - task polar-odysseys-7cc602f23977
repro: agents/tests/blackbox/benchmark.blackbox.py::test_polar_judge_sees_final_completion_summary
status: mitigated
---

## Problem

In Polar batch 1, 9 runs across 5 polar-odysseys tasks failed the
`odysseys-rubrics-perfect` evaluator on a rubric that asks for a final combined
summary. The judge wrote reasons like "steps 261–265 ... not a final user-facing
summary". Exemplar agent 25c02595 (7cc602f23977 K2) actually finished with a
`completion_summary` TOOL row (`isFinalSummary: true`, `toolStatus: FINISHED`)
whose `text` is `""`. Its `metadata.completionSummary.summary` held the answer
("I found a green Theory evening dress ... left both product pages open in
separate tabs ..."), and its `outputs` held the dress, shoe and ooShirts
details. All 9 Hub transcripts have the same shape: empty text, a 231–325 char
summary and 3–7 outputs in metadata.

## Diagnosis

Path: workflow `_post_message("", "TOOL", {completionSummary...})` → backend
message row → agent detail API → `run_benchmark._run_declared_evaluators`
(method polar) → `polar_evaluator.build_polar_trajectory` → judge prompt.

- The workflow posts the final answer in metadata on purpose
  (`agent_workflow.py`, "Post FINISHED message with completion summary"). The FE
  `CompletionBubble` → `CompletionSummaryCard` renders `summary` and `outputs`
  from that metadata, so the user does see the answer. The agent and harness
  are correct.
- `build_polar_trajectory` gets text from `_message_text` (text/message/content
  only) and never reads `completionSummary`. The final step therefore became
  `265. Action: completion_summary | status=FINISHED`. Replaying the Hub
  transcript through the builder produced exactly the step numbers the live
  judge cited (261–265), which shows the archive is byte-equivalent judge input.
- Upstream Odysseys (`scripts/python/run_full_trajectory_per_rubric.py`,
  lines 179-180) writes each step's agent `response` as `Response: ...`, so the
  agent's final answer is part of the history. The sibling Rose evidence builder
  (`semantic_evaluator_evidence._append_completion_card`) already turns this card
  into a final_completion ASSISTANT row. The polar isolation contract forbids
  importing that module, and polar had no equivalent.
- Why was this possible? The polar builder was written against generic text
  fields, and no test fed it a real Rose completion transcript. Its unit fixture
  only had text-bearing ASSISTANT/TOOL rows.

## Solution

`polar_evaluator._completion_card_text` renders a FINISHED `completion_summary`
card as the FE does: the summary, then one `- label: <json value>` line per
output. `build_polar_trajectory` emits it as that step's `Response:`, before the
unchanged `Action: completion_summary | status=FINISHED` line. Rubrics, the judge
system prompt, the user-turn template, thresholds and the model are unchanged.
Regression: `test_polar_judge_sees_final_completion_summary` in the agents
`benchmark` blackbox domain feeds the real 25c02595 Hub transcript (Kernel
live-view tokens redacted) through `run_polar_evaluator` with a capturing judge.
It asserts that the final step starts with `Response: <summary>` and contains
every output. Each run adds O(1) work for its single final card; nothing scales
with agent count.

Judge-only replay (2026-10-20): the 9 saved Hub transcripts were judged with the
production judge call, 92 Rose calls served by gpt-6-sol-foundry and
gpt-6.1-sol-foundry. On origin/main 9/9 failed, matching the live verdicts. After
the fix 5/9 pass: 7cc602f23977 K2/K3, 8ac68fada21a K1 and ec290c1a334e K1/K3. The
other 4 still fail, and their judges now cite the content of the final answer:
missing Amazon UK options, product tabs closed at teardown, and a briefing that
is not integrated.

## Human feedback

None recorded.

## Reusable lesson

When an evaluator flattens a Rose transcript, render every metadata-only row that
the FE shows as content, above all the `completion_summary` card. Prove it with a
real transcript rather than a hand-written text-only fixture.
