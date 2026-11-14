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


## R75: original It20 BU071 run1 carrier

Independent normal packet verification for root
d8d6a92f-a83a-4ef4-b83a-51210db08b5c/job r001-j0001 confirms the same observed
presentation boundary on source4016ffaf50aeee0eff1b242d9e348f54896fdc02,
patchnone. All seven normal member sizes and hashes match manifest
91bdaa634c160470cbbc1803fb240061a420f7307de2d39adce2e6679eb4bf2f.
Archive SHA256 is
55a79d211e1eb37676dbc72074fddbd9e6ec2776d29ae657dc96785f07a9a224;
run JSON SHA256 is 3beab7fbe67c4ccf0dd94a117370b6c762296d4cac6d9773abc9f0cd79a5c6a6.
Native COMPLETED in1168.1seconds remains distinct from the canonical
three-of-four FAILED/infraFALSE result. C1/C3/C4 passed; C2 rejected the visible
report and structured field instead of the requested bare day.

Original user message0 ends “Just give the day of the month.” Message6's
required integer wikipedia_access_day schema retains the requested quantity.
Message224 explains the day is4 using the recorded endnote; message225 contains
the ordinary Goal/Status/Outcome/URLs/reasoning report. Message231's completed
child structured_response is wikipedia_access_day:4. Message236 presents the
root's labeled “Wikipedia Access Day:4” extraction. Final message238 stores4
under completionSummary.outputs. There is no later bare-day reply, altered
integer, truncated scalar or wrong declared type.

Exact-source helpers.llm.check_progress checks completed child fields, returns
their structured data, and supplies a generic reasoning message; ordinary
browser build_context_summary and final summary retain the labeled carrier.
This source mapping agrees with the original persisted outputs. It is not a
replayed model outcome or an independently captured declared-judge HTTP request.
The record's C2 explanation explicitly identifies the presentation mismatch;
C3 notes that no screenshots were attached for independent date reading. We
retain that evidence limitation rather than claiming to revalidate the date
from remote images or reread the PDF.

The R71 Solution and Human feedback were reread and archive searches used
bare-answer/labeled-carrier and day-only vocabulary. This is the same observed
contract boundary, appended here rather than starting another fix lane. A
broader answer-only output contract remains unimplemented and would require
its own general design and causal proof. No task-specific scalar override,
trajectory filtering, prompt change, model replay, runtime edit or regrade was
performed. Original grades and active source remain unchanged. Tokens UNMETERED.
