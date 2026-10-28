---
id: 2026-10-28-it13-bu061-calendar-list-and-reference-answer-disagree
date: 2026-10-28
title: It13 BU061 returns three from calendar lists while C4 requires six
surface: agents
component: polar-list-basis-and-reference-answer
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: captured domestic Calendar grosses view yields three overlaps while declared C4 requires six; intended alternative list basis remains unproved
symptoms:
  - polar perfect-score failed (3/4 rubrics)
  - Ground truth is satisfied exactly when applicable: 6
  - Calendar grosses
  - top10_overlap_count 3
tags:
  - polar
  - it13
  - r32
  - list-basis
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 9ab57116-b82e-42c3-a2ae-bab21d4c79ff
  - fleet run 20261028-230246-3988127
  - plan: archive 584ca7a9e8ea6a2e17fe4a77ea1f07e68ada5a719bb01dae465ee298db49db1e
  - plan: normal manifest aad4f5a7589c046d8a264fa4e98732ebe43368bcedaad0acd3e6de68f358cc2e
repro: none-recorded
status: open
---

## Problem

Original BU061 r1, job r001-j0011, completed its root in85.3seconds but failed
one of four declared rubrics. C1, C2 and C3 each passed; C4 requires exactly6
while the submitted integer is3. Original taskFAILED/infraFALSE is preserved.
The assignment began2026-10-28T23:14:06.655977Z; this is bounded offline intake,
not a completed benchmark repair. Investigator usage is UNMETERED.

All seven normal runtime members and separately labelled supplemental receipts
match SHA256SUMS. Normal run.json SHA256 is
244004c03661ea5b334618dfc310989d8f31ba39565adcf7a840b16b06b07348.
Its provenance records executed765caac, patchnone. The exact qualified source
ref was fetched once and verified equal765caac; no main sync, environment or
live campaign change occurred.

## Diagnosis

Original messages16 and20 record successful evaluate results at23:08:39.720Z
and23:08:49.337Z (browser steps2 and4). The first extracts ten worldwide rows
from `/year/world/2020/`; the second extracts ten domestic rows from
`/year/2020/`. The latter final DOM explicitly displays **Calendar grosses**.
Both extraction scripts select table rows and return their titles and numbers.
The shared titles are Bad Boys for Life, Sonic the Hedgehog and Dolittle.
Domestic rows also contain1917, Jumanji, Star Wars and Little Women. These are
captured observations; their presence alone does not prove the task intended a
release-year view or that its imported answer is stale.

The actual five-message native verifier request a6f565e52215 has SHA256
 ebfbe21a0894da32fe99f9f16a05405db59d0dde37ec3144ce60a62c08ad0e89.
Its final DOM retains the Calendar grosses heading and its TOOL_RESULT entries
retain both full ten-row lists. The response at23:09:13.950207Z has SHA256
04d2834265f47b0a6051162b619048a247ab3d72732848c482280f46fa1cf2cd;
it returns top10_overlap_count=3, task_completed=true, score1.0, explicitly
calling the domestic view default calendar grosses. No table omission was
identified at this captured actor-to-verifier boundary.

At exact source765caac, `agents/benchmarks/polar/bu_bench_v1.json` imports
answer6 for task5a0c2db3-a687-4dfe-b7e7-22d01eae23f6. The catalog producer
`polar_catalog.py:_bu_entry` adds C4 from that supplied answer. The independent
`polar_evaluator.py:run_polar_evaluator` judges each rubric and requires all to
pass. Its original recorded C4 reasoning explicitly acknowledges the same three
shared titles but fails the answer against6. This is an observed disagreement
between captured list basis and reference answer, not proof the evaluator code
miscomputed the intersection or that a task-definition change is warranted.

The offline `.context/rca-r32/inspect_original.py` verifies all packet checksums,
computes the original list intersection, checks all20 source titles survive the
native request, and invokes the actual765caac Polar trajectory/user-text builder.
It passes with intersection3 and C4=6 retained in the reconstructed projection.
This is custody/arithmetic/projection verification, **not** a failing-bug/repair
RED-GREEN pair, model replay, or byte parity with an independently retained final
judge HTTP request. Original structured judge results are retained; no separate
final judge wire body is established here.

There is no captured navigation to an alternative domestic release-year view:
recorded URLs are about:blank and the two paths above. Whether another intended
list yields6, or historical page contents differed, is unproved by this packet.
No current website queries were made. Thus a deterministic general runtime
repair cannot be justified from this intake.

Archive searches used `Box Office Mojo`, `calendar release year ground truth`,
and the earlier exact-answer/list mismatch terms. No same-boundary recurrence
was established. The fresh-clock case was opened including Solution and Human
feedback: it addresses missing current-date injection, unlike this explicit2020
request. Search vocabulary overlap is not recurrence evidence.

## Solution

No runtime candidate, prompt/schema/rubric change, forced answer6, provider
change or speculative regression test. Keep this OPEN. The next useful evidence
would identify the task-authoritative domestic list basis and its original
reference provenance, or existing captured alternative-view observations. Do not
replace the original grade with a claim that3 is accepted; do not manufacture a
new browser request to settle the ambiguity during the live campaign.

No provider/model/API/browser/DB/image/publication calls occurred. No original
source, clocks, task definition or cleanup receipt changed. Exact source and
packet inspection suffice to exclude a missing-table transport claim at the
captured native verifier input; they do not prove the task would pass unchanged.

## Human feedback

The parent required original evidence before family classification, prohibited
rubric/answer hardcoding and web research, and clarified that calendar versus
release-year interpretation is a lead rather than proof of stale ground truth.
The parent kept the active765caac campaign frozen and authorized only a fetch of
the exact qualified source ref when it was missing locally.

## Reusable lesson

Pin the captured list basis and reference-answer provenance before treating a numerical disagreement as either a transport bug or a stale benchmark answer.
