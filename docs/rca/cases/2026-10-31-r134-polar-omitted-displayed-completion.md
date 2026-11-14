---
id: 2026-10-31-r134-polar-omitted-displayed-completion
date: 2026-10-31
title: Polar trajectory omitted the rendered final completion card
surface: harness
component: polar-evidence-projection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Polar converted an empty-text completion_summary row to a tool status without its visible summary and outputs
symptoms:
  - Native completed with progress one but Polar failed the final-roundup rubric
  - The UI completion card had an explicit page-view confirmation
  - The judge trajectory ended with a contentless completion status
tags:
  - r134
  - polar
  - completion-summary
  - evidence-projection
sources:
  - commit 618430e2a32e619406cb24fb537e2f6e2fe291e7
  - agent 945183cd-a9c0-442e-b96a-7782257761e2
  - benchmark run r002-j0011
repro: Same original completion message through actual Polar evaluator input capture loses summary on baseline and preserves it with the candidate; no model call
status: open
---

## Problem

It31 polar-odysseys-0106b570440f natively completed with progress1, but the
original Polar result remained5/6FAILR6. The grader said no concise user-facing
roundup or explicit Epic page-view confirmation appeared in its trajectory.
Original archive3904234cd7a63a7f858fb35be9a390eaff3ae17f67f6811f57165a1a3149f295
and all normal7 members verify. No original grade is changed.

## Diagnosis

Zero-based message index226 (the227th saved message) is a completed completion_summary TOOL row with empty text. Its
metadata contains the summary and structured outputs shown by the frontend.
The summary explicitly confirms viewing the Epic homepage, Halloween sale,
and Split Fiction page; outputs include the four deals/categories/prices.
Raw summary-model output and persisted summary text match exactly.

Exact CompletionBubble/Card/Sections render the summary and all18primitive
output values. A bounded SSR of those real components confirms their visibility;
motion, icons and clipboard are inert, and full authenticated FE is not claimed.
The Polar converter retains only the message text and selected browser metadata.
It drops the completion card and emits only the final tool status. Exact original
projection has226steps/two screenshots and SHA66be22d9701d2577b6f9ec6c42c762039878ed1b70a0b6006bae6d00c06222da.

Three browser transport closures recovered within2.4–2.9seconds. Later recording
and session-cleanup warnings remain separate lifecycle facts; they do not prove
an unrecovered transport cause for this completed task. Raw original judge wire
was not present in supplied dumps. The source replay proves missing visible
content, not that a hypothetical rerun would pass R6 or that no other semantic
issue exists.

## Solution

Candidate ee0bbd02c7aee5df7a51e73f65a7e96554421b4db81e9742d70450e84c74e54c adds the existing displayed completion to its same
Polar action row. It selects typed finished completion messages only, preserves
value-mode answerText precedence, and exposes only report summary and visible
output label/value. File pointers reveal filenames rather than storage paths;
private metadata, costs and hidden report values are excluded. The isolated
Polar module does not import other evaluators or change prompt/rubric/model.

The original full227message replay preserves the entire baseline projection as
a prefix and both screenshots. All six captured rubric requests gain the
existing summary; the inert judge deliberately returns failure throughout.
No benchmark score is manufactured from this evidence-fidelity control.
The first draft was rejected for hidden-field and final-card visibility gaps.
The second draft follows the exact outer final-card filters and renders only
visible text, with filename-only file widgets and strict error flags.
Independent review qualified the exact V2 after reproducing the original
omission, visibility controls, all16tests and six registered tests. This case
does not claim completed integration or any changed benchmark verdict.

## Validation

Same original-message owning control is baselineRED/candidateGREEN. Six new
methods in the existing Polar test module cover the original card, value-mode
hidden-report suppression, file-pointer/privacy fields, malformed/unrelated
carriers, deduplication and error cards. The module has16passing tests, including
existing isolation/lazy-dispatch checks. The existing benchmark-live-results
gate includes this module and selects the six new polar_browser tests.

## Human feedback

The standing task requires faithful original evidence and unchanged benchmark
criteria. Restoring a displayed answer must not become a generated replacement
answer, evaluator waiver or retrospective PASS claim.

## Reusable lesson

When final answers live in typed metadata, transcript adapters must project the
same visible content as the user interface. A contentless tool-status line is
not equivalent to the displayed final answer.
