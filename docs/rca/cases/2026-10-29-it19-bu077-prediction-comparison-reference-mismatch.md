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


## R74: original It20 BU077 run1 comparison

A separate original run on source4016ffaf50aeee0eff1b242d9e348f54896fdc02,
patchnone, repeats the observed comparison/reference disagreement. Root
bd7c0ddb-2745-4c5f-aeb2-8703670d216f, jobr001-j0007, completed natively
in1477.9seconds; the benchmark failed C4 while C1/C2/C3 passed, infraFALSE.
No original grade is changed. All seven normal member sizes and hashes were
independently verified against manifest
 aa787f80ea0579f2b146e289667a77005efb9a2299a0f21ea07d7e6015ed0686.
Archive SHA256 is
62bce7470d8c38301d52cb895990006b9c816de962279c214ef2fc74d9c61602;
run SHA256 is ebbbeafa45975e86e350e9f614f94a91e117723ce0ddea41c11ef66495ce3e48.

Original message52 captures the MIT transcript's unnamed SCIENTIST2 predicting
robots in ten or fifteen years. Original message182 captures
https://voiceinthemachine.com/2012/06/18/can-machines-really-think/ attributing a
four-or-five-year thinking-machine prediction to Jerome Wiesner. It embeds the
named video. These are retained page observations, not newly verified video
identity or independent proof that the imported reference answer is wrong.

The final actual actor call at worker22322 has encoded payload SHA256
5b872e0503916415bcee565b7128b211455395217e6dd1e2aae7bcbf974f623e.
Its messages contain both time ranges; its output calls attempt_completion.
Message184 retains the browser verifier's input-text projection and reasoning:
the page names Wiesner, whose four/five-year estimate is sooner under the
user's same-year assumption. Message191 retains scientist_name=Jerome Wiesner;
root verifier196 and final summary198 preserve that name. No downstream
substitution or omitted final value is demonstrated. Separately encoded raw
browser-verifier request/response was not located in the supplied worker log;
the persisted input projection and result are not claimed as raw wire parity.

The recorded C4 result explicitly rejects Wiesner against Claude Shannon.
Archive searches for Wiesner/Shannon and reference/comparison disagreement led
to this case, whose Solution and Human feedback were reread. The original
comparison now has more direct recorded transcript evidence, but the unresolved
semantic/reference relationship is the same observed boundary. No general
runtime repair follows. No forced scientist answer, prompt nudge, task/rubric
change, model replay, remote browsing, or new provider call was performed.
Native completion, benchmark failure and the OPEN outcome remain distinct.
Tokens UNMETERED.
