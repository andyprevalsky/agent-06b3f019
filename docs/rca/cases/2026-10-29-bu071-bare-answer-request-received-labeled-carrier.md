---
id: 2026-10-29-bu071-bare-answer-request-received-labeled-carrier
date: 2026-10-29
title: BU071 requested only the day but received a labeled report carrier
surface: agents
component: browser-completion-presentation
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Correct typed integer 4 survives child and root completion, but ordinary report and labeled extraction text violate the requested bare-day presentation; no scalar transport loss
symptoms:
  - "recorded final output is a labeled report and structured response, not just the day of the month"
  - "polar perfect-score failed (3/4 rubrics)"
tags:
  - polar
  - bu071
  - output-format
sources:
  - commit 4016ffaf50aeee0eff1b242d9e348f54896fdc02
  - agent 27b3579d-aadc-4b61-963b-d6aa03a6053e
  - plan:.context/r71/proof.json
repro: none-recorded
status: open
---

## Problem

It20 BU071r2 requested the day in November on which an endnote's Wikipedia
article was accessed, ending “Just give the day of the month.” Native completed
in793.3s, but the declared evaluator passed C1/C3/C4 and failed C2 presentation.
CanonicalFAILED/infra_failure=false joined19:19:40.454422Z remains unchanged.

## Diagnosis

The original seven-member normal archive SHA
53ce6a5386969aa7d4c544cd7d1cd3c536a16a995393cdea01f723a41d621d48
was verified with every member's size/hash. Exact run source4016ffaf/patchnone.
The generated required integer field wikipedia_access_day holds4 in both the
child's task_complete structured_response and root persisted structured_output.
The final root completion summary also holds integer4. There is no scalar
truncation, wrong output type, missing field or schema length constraint.

The child report includes Goal, Status, Outcome, URLs, reasoning, actions and
“Extracted Output: Wikipedia Access Day:4.” The root's completed-child shortcut
in helpers.llm.check_progress preserves the structured value while producing
a labeled extraction report. build_context_summary owns the ordinary child
report. Polar build_polar_trajectory retains the corresponding text and
structured response. An offline projection from original messages shows both;
it is not claimed to be an independently captured encoded judge request.

The independent judge explicitly accepts the lookup and correct answer but
rejects the verbose carrier under the bare-day requirement. Changing the
expected answer, stripping evaluator history, or inserting a task-keyword
format override would not establish a general repair. A broader answer-only
presentation contract would need distinct design and causal owning proof;
none was implemented in this bounded intake.

A separate excluded-from-model cleanup message at19:12:17.746Z reports browser
session cleanup failed with http_status null. The later normal cleanup receipt
records DELETE204 for the same session, root deletion/tree sealing and no
errors. This recovered cleanup axis is not the C2 cause and does not supply
positive evidence of a new terminal infrastructure failure.

## Solution

OPEN; no runtime candidate, model/provider/browser/native/DB call, task regrade
or new timeout. Preserve the correct typed output and the actual user-visible
carrier together. Archive searches covered labeled/bare-day structured reports
and completion presentation; no identical proved first-bad case was found.
All original source, grades, clocks and cleanup receipts remain unchanged.

## Human feedback

The coordinator required original native-versus-evaluator separation, actual
schema and transport tracing before cause attribution, and a bounded decision
without a speculative answer patch or policy change.

## Reusable lesson

Verify both the typed answer and its delivered presentation when a user asks
for only a scalar, without rewriting evaluator evidence to hide the carrier.
