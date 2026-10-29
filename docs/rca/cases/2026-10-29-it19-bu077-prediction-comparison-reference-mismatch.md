---
id: 2026-10-29-it19-bu077-prediction-comparison-reference-mismatch
date: 2026-10-29
title: BU077 selected Wiesner from captured predictions while the reference required Shannon
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: other
first_bad_boundary: The actor and verifier compare captured four-to-five and ten-to-fifteen-year predictions and return Wiesner, while declared C4 requires Shannon; no mechanical loss established
symptoms:
  - Native COMPLETED but benchmark failed C4
  - Captured secondary sources support the submitted comparison
  - Declared C1 through C3 passed while C4 required another name
tags:
  - r67
  - it19
  - reference-answer
  - source-comparison
sources:
  - commit d1b1062cfd420832467d4e2b7e10c770a0318157
  - agent df492f8e-2844-4511-9264-aa9673571f60
  - fleet run 20261029-175440-3819605
repro: Original encoded verifier input/output and recorded rubric results
status: open
---

## Problem

Original It19 BU077r1 jobr001-j0007 ended at18:20:44.927649Z, before the
parent's stop. Native status wasCOMPLETED in644.3seconds, while the canonical
benchmark failed3/4rubrics with infraFALSE. The task asks which scientist in
The Thinking Machine predicted thinking machines or robots sooner, assuming
the interviews occurred the same year. Its supplied C4 answer isClaude Shannon.
The actor returnedJerome Wiesner. Neither result nor grading is changed here.

## Diagnosis

ArchiveSHA256
`cd421ac334425341f6ba71f9200b2275ceab42b7f9a421f154d6e0ce301a71ee`;
all seven normal member sizes and hashes match manifest
`086c8f33d0436f9ffd08cb5019f2cfe50bcee6d8f53cfd7fd65585f49ad4a22e`.
RunSHA256
`1e81639cb5b7c91921c3f9c16da533e53d9eb300092618a2784f5699813b1df0`.
Original source and patchnone match the supplied binding and provenance.

The generated required scientist_name field preserves the requested comparison
and First name Last name format. Original message62 captures a Bing result
attributing a ten-or-fifteen-year robot prediction toShannon. Message77 records
an evaluate result from shortdistance.substack.com/p/the-year-was-1961 with the
same attribution. Message85 extracts text attributing a four-or-five-year
thinking-machine statement toWiesner. Message103 captures a Bing page repeating
that comparison. The actor explicitly considers which estimate is sooner.
These are recorded secondary-source observations, not independently validated
video testimony or proof the reference answer is wrong.

The actual verifier request at worker line13051 has payloadSHA256
`d113d1602d1b34a12cecece49f456d0f254e54e150e1d4a5d23c36449753eb2e`.
It retains both names and both time ranges. The raw response at line13108,
payloadSHA256
`7e6bc384760c79577e54527768bc075a25d0ed33a52f605abf13a9b4dc569cfb`,
returns scientist_name=Jerome Wiesner, task_completed=true and score1.0,
explicitly citing the comparison. Child output, root verifier117 and final
summary119 preserve that name. No later transport substitution is shown.

Declared C1/C2/C3 accept the comparison and evidence consistency. C4 rejects
Wiesner against the supplied Shannon answer. The recorded rubric results are
available; independent raw declared-judge HTTP parity is not established.
The archive's calendar-list/reference disagreement case was read as a comparator,
not a proved recurrence. Searches for ground-truth/source disagreement and
Shannon/Wiesner identified no existing exact case.

## Solution

OPEN: no general runtime repair is justified by these originals. The unresolved
boundary is the relationship between the requested video's intended comparison,
the reliability of recorded secondary quotations, and the supplied reference.
Do not force a scientist name, change the question/rubric, suppress captured
source evidence or introduce a task-specific keyword rule. No new model, video,
website or provider call was made. The original canonical failure remains.

## Human feedback

The coordinator required original evidence before grouping with earlier cases,
with native completion, benchmark failure and infrastructure status kept
separate. Existing future docs composition remains independent. Tokens UNMETERED.

## Reusable lesson

A preserved, explicit comparison can disagree with an imported answer without
proving transport loss or a grader defect. Record the exact source basis and
verifier decision before proposing any general repair.
