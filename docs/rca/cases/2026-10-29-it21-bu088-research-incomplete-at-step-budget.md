---
id: 2026-10-29-it21-bu088-research-incomplete-at-step-budget
date: 2026-10-29
title: BU088 research remains incomplete when the browser step budget pauses execution
surface: agents
component: browser-research-and-benchmark-terminal-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Last captured actor selects another search without a verified answer; budget pause and low root progress are observed but no causal runtime defect is established
symptoms:
  - "Browser step budget reached: 100/100 — pausing for polar judge"
  - "Low progress score: 0.00"
  - "User paused the browser agent"
tags:
  - r82
  - it21
  - polar-bu-088
sources:
  - commit 47a0e9d6c9a89e2d97933935509343372d565250
  - agent d47f4641-96e4-41fa-a175-ada09d75fa6d
  - plan: normal archive a2f4c1ba1a556d7d9cccb83a8e32b092161b054547ab8cae1a6fa040245cd56b
repro: none-recorded; original request and outcome custody only
status: open
---

## Problem

Original It21 BU088r1/job r001-j0008, fleet20261029-204111-3891934, ran
source47a0e9d6c9a89e2d97933935509343372d565250 with no patch. The task asks
for the type of pill taken by the younger of two deceased individuals, using
specified date, age, distance and common-coroner clues. Native status PAUSED
and duration2222.1seconds are distinct from canonical FAILED/infraFALSE,
joined2026-10-29T21:30:34.523278Z. No approval was triggered or resolved.

All seven normal member sizes and SHA256 hashes independently verify against
manifestc245afc8e101a0b9b877a9182daa901c48884c2fbdfb191414b43e3740461c3b.
The normal run SHA256 is
fc1e990b19f307f45e1bea9c35bc07c766f726e4b094355c0bbbb1ebb282d607;
worker6e8724072e1583aff6726649479b835e4871cd0e9b42482f44f5dfd896b4af96.
Supplemental driver/lifecycle files are separately bound by the supplied
receipt, not claimed to be members of the normal runtime manifest.

## Diagnosis

The observed path is original task and schema -> repeated native research
navigation/evaluation -> runner step-budget pause -> low root progress failure.
The schema asks for required nonnullable string pill_type and report mode.
There is no recorded completed answer or completion-verifier exchange.

The actual last completed actor request browser_use_step_99/request74d98fe2d508
is captured at worker line25013. Its decoded bytes match
3bc3508d729ed39d745837fe5a728eb156fc62f71d5ff1d3ff9c332b57544317.
All original task wording is retained in this input. Its output chooses another
Google search with the coroner/age/pill clues, not attempt_completion.
The prior step98/request462e88c0347c has request hash
6eb5019c07dde96e82e8eaff740e581871c7e8a9cbdebe18811251040bcfa63f and
reads the current search page using JavaScript. Earlier Google/Bing/native page
results and unsuccessful candidate searches remain in the original history.
No controlled replay establishes a model-capability or transport cause.

The supplemental driver explicitly reports at line17524:
“Browser step budget reached: 100/100 — pausing for polar judge”. Exact source
run_benchmark.py5088-5113 counts browser steps and calls pause_agent for this
condition. Backend POST/pause starts21:26:06.142Z and returns200 at
21:26:06.465Z; workflow cancellation is recorded21:26:06.637041Z.
Actor step100 starts21:26:09.026931Z, but no completed step100 dump is present;
activity cancellation logs21:26:09.635547Z. Workflow signal and local activity
cancellation delivery are not interchangeable timestamps. This is not evidence
that a human manually paused the run, nor proof that a missing local guard
caused research noncompletion.

The driver finally reports Low progress score0.00. The native root progress
field is0. evaluate_task permits the intentional Polar budget PAUSED status
but then rejects low progress; run_single_task invokes declared evaluators
with static_only when that prior result failed. Thus no declared semantic
rubric result is present, and none is invented here. Zero aggregate model
calls/tokens/cost does not prove zero execution: worker logs contain111
rose.complete.start events and110 captured request dumps, including real
browser actor calls and ten observation actions that did not consume budget.
Those counts are log coverage, not independent billing totals.

A separate terminal browser cleanup returnedHTTP500, visible in messages236,
239 and240. Later normal cleanup records DELETE204 for the same Tilion session,
no cleanup errors, a sealed tree and root soft-deletion. The retained root row
still exists; this is not physical row absence or a claim of global resource
absence. The transient error does not establish a terminal infrastructure
failure or explain the preceding incomplete research.

## Solution

OPEN, no runtime candidate. No cap increase, task-specific query/prompt,
forced pill answer, criterion change, model replay or new provider call.
The captured requests establish ongoing research and its stop boundary, not
a reproducible mechanical defect or a validated answer before the pause.
A causal repair would require an actual owned faulty transition or a controlled
unchanged input comparison; neither was established from this bounded intake.
The active run and original result remain unchanged.

## Verification

Read the actual normal actor/schema/worker/backend and supplemental driver
bytes, checked all seven normal hashes, and decoded the final two captured
actor requests with their payload checksums. No runtime test or live replay was
claimed. Archive searches used “Low progress score” and “step budget paused
research”. Read the Solution and Human feedback of the BU067 source-price pause
case and the BU051 historical-diagram case. They are relatives in budget/grade
reporting, not proof of shared missing visual or source-specific evidence here.
A new bounded case avoids merging distinct research questions or causes.

## Human feedback

The coordinator required original native-versus-benchmark separation, urgent
reporting of positive infrastructure evidence without independent stop authority,
and no cause inference from PAUSED alone. Preserve active source and original
outcomes; no old-family assumption, task-answer patch or paid rerun. Tokens
UNMETERED. The recovered cleanup500 and later204 were reported separately.

## Reusable lesson

Trace the actual pause initiator and last captured actor decision before
classifying a low-progress result or treating missing aggregate usage as no work.
