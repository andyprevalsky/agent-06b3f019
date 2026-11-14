---
id: 2026-10-28-it9-bu040-original-query-date-evidence-pending
date: 2026-10-28
title: It9 BU040 query and capture-date evidence pending normal export
surface: harness
component: investigation-evidence-availability
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: investigation has terminal C1 reason but not original query and date-field evidence; runtime cause unproven
symptoms:
  - polar-bu-040 r001-j0025 failed C1 with two of three rubrics passed
  - terminal reason distinguishes Space with image filter from requested Space images
  - terminal reason says Published dates were not verified as capture dates
tags:
  - polar
  - it9
  - bu040
  - evidence-pending
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent 9158829b-c214-4b3c-a9ab-41be927b6334
  - fleet run 20261028-075834-14224
  - plan: row packet sha256 e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2
repro: none-recorded
status: open
---

## Problem

Initial availability notes are historical; the normal-export follow-up below
supersedes that availability floor.

R19 is a bounded local read-only intake of BU040 repetition1. Job
`r001-j0025`, root `9158829b-c214-4b3c-a9ab-41be927b6334`, fleet
`20261028-075834-14224`, finished `2026-10-28T08:19:46.860839+00:00`.
The original row records task_status FAILED, exit1, infra=false, released=true.
Wrapper status passed and verdict COMPLETED do not establish task PASS.
Original task FAIL is preserved.

The terminal C1 reason says the actor entered Space at step19, selected
mediatype=image at21 and confirmed that results URL at25. It says ten titles
and dates were extracted at51 and returned at68, but the dates were labeled
Published without capture-date verification. These are quotations from the
result row, not independently inspected native actions or judge input. Query
and date semantics must be established from the actual task and evidence;
neither equivalence nor a mismatch is inferred from this summary alone.

Failed raw-row SHA256:
`dd5c211675837254d59afdac12cb6be8d23ea90b6967f55addd56443ff177dd2`.
PASS sibling `r002-j0055`, root `f9c5c92a-1d43-4eff-adf2-586b8c0e18ef`,
fleet `20261028-075834-14310`, raw-row SHA256:
`4bbab32bd9c617497394b1a5ccf20ff4bcc00024b158f0977d1e0564295a7ef8`.
The sibling is an outcome comparison, not proof of the failing actor's cause.

Unchanged catalog SHA256:
`0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9`.
Exact task below preserves its literal backslashes:

    Use advanced search for \"Space images\" on archive.org and output the capture dates and titles of the first 10 images listed.
    website: https://archive.org

The three Polar rubrics, browser requirement and100-step maximum are unchanged.
No minimum step value is authored. No task criteria are reinterpreted here.

## Diagnosis

OPEN at an investigation-local availability floor. The original generated
schema, actor/native query and field labels, result payload, internal verifier
request/response and all three external judge request/response bodies have not
yet arrived through the normal verified export. This does not establish runtime
capture loss, a model cause, schema narrowing, incorrect dates or evaluator error.

Source inspection identifies the next boundaries without diagnosing them:

- helpers/llm.py759+ preserves generated schema properties/descriptions and796+
  generates the schema. Compare the actual captured input and output.
- service_actions.py1112+ dispatches native interactions, including input_text
  and dropdown selection. Compare exact query arguments and observed results.
- handler.py11625+ builds verifier context from goal, native observations,
  instructions and history;11753 retains explicit task_completed admission.
- polar_evaluator.py206+ builds trajectory evidence;406+ invokes the rubrics.
  Compare its actual admitted evidence with the native source, not row prose.

Required normal packet for both roots: literal task, generated schema and its
request, actor messages/actions, actual query URL/fields, listing and detail date
labels/values, extracted result, verifier task_completed and data, final handoff,
and all three judge inputs and responses. Preserve hashes and call identities.
A rendered listing date alone does not establish its semantic type. No prior
BU040 archive match was found; generic archive hits are not recurrence proof.
R15 and R17 remain separate OPEN cases awaiting their own normal packets.

## Solution

No runtime change, speculative regression, query rewrite, date conversion,
schema/prompt/criteria/cap change, regrade or new run. Requested only existing
normal verified export from the launch owner. Resume this same case when it
arrives. Any later repair requires an owning registered causal red/green control
and exact independent opened-reference GROUNDED review before application.
Unchanged real-task outcome remains a separate proof requirement.

Local row/catalog/source receipt: `.context/r19-it9/intake-receipt.json`.
Actual scope BU040 only; token usage UNMETERED.

## Human feedback

The parent required a five-minute milestone and ten-minute intake, no extra
provider/controller/guest/DB/browser/model calls, no inference from a C1 quote,
and no reinterpretation of literal query or capture-date semantics. Preserve
Freedom and all resources; active source/operator remain unchanged. Stop at an
honest investigation-local OPEN floor while normal originals are pending.

## Reusable lesson

Bind literal task semantics to actual query, observed field meaning, structured
result and judge input before deciding whether an apparent mismatch belongs to
the actor, schema, evidence transport or evaluation.

## Normal export follow-up: literal query mismatch retained in verifier input

The normal shard-00 packet arrived with SHA256
`fe3f2bd6c4a24d2ecce872a8d0d08170274f751bc8660551da0a55f43483ce61`.
It contains both pinned runs and owner-reported verified export/release evidence.
Only local originals were read; no provider/browser/model calls were made.
Message indices below are zero-based logs.messages indices, not judge numbering.

The failed run contains72messages. Its schema at6 and57 still describes the
first10 image listings from advanced search for Space images, and requires title
and capture_date. There is no observed schema rewrite to the shorter query.
Actual native input_text18 supplies Space; select_dropdown20 supplies image.
Evaluate54 uses the page search API with user_query=(Space) AND mediatype:(image).
Evaluate50 records the rendered titles with dates explicitly labeled Published.
Evaluate52 queries a different API ranking; evaluate54 returns metadata date,
addeddate and publicdate separately. Neither changing the label to capture_date
nor retaining distinct metadata fields establishes their semantic equivalence.

Browser verifier56 explicitly says entering Space and image mediatype performed
the advanced search correctly. It lists the Published values, then calls all10
required title/capture-date pairs grounded. The recorded browser_verifier_input
retains the relevant actions and observations. Final structured response63
contains those10title/date pairs. External C1=0, C2=1 and C3=1: the latter two
confirm correspondence with observed listings, not completion of the literal
query or proof of capture-date semantics. The observed first task deviation is
therefore native query entry18; later semantic verification accepts it despite
the goal and schema still naming Space images. No task-specific repair follows
from this observation.

The PASS sibling contains85messages. Native input_text34 enters Space images,
select_dropdown36 chooses image. Verifier60 initially rejects completion because
the supplied ten identifiers were not grounded as the first ten results. The
actor then uses evaluate68 to extract ordered result anchors from the actual
DOM, fetch matching metadata and return the query URL. Verifier70 accepts this
linkage and date descriptions; final response77 has ten supported entries.
All three external rubrics pass. This is a useful control for observed workflow
differences, not a model counterfactual or proof that a prompt change fixes the
failed run. No new visual inspection was performed.

The original C1 FAIL remains unchanged. Current classification is an observed
actor query deviation and overbroad semantic completion judgment. No schema
narrowing or evidence-loss repair is demonstrated. Raw schema-generation and
provider verifier JSON response envelopes, including the explicit task_completed
bit, are not established by saved message projections alone. Full external
provider request envelopes are likewise not established by rubric result rows.
A generic faithful-completion repair remains OPEN and needs exact causal
controls/independent review; do not implement Space/date heuristics, task edits,
query rewriting or judge relaxation.

The compact source-indexed evidence, run hashes, captured schemas/actions,
verifier input and all rubric results are in
`.context/r19-it9/original-analysis-evidence.json`. No runtime code or speculative
test was changed. Actual scope BU040 and its pinned sibling; tokens UNMETERED.
