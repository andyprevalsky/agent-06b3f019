---
id: 2026-10-29-it20-bu080-character-name-reference-mismatch
date: 2026-10-29
title: BU080 returned grave for the tested backtick character while C4 required backtick
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: other
first_bad_boundary: Actor and verifier select grave from retained shortest-name evidence while the declared exact-answer rubric requires backtick; no mechanical loss established
symptoms:
  - Native COMPLETED in 224 seconds but benchmark failed three of four rubrics
  - Original shortest-name instruction and captured naming evidence survive into verifier input
  - C1 through C3 accept the result and C4 rejects the exact returned name
tags:
  - r70
  - it20
  - character-name
  - reference-answer
sources:
  - commit 4016ffaf50aeee0eff1b242d9e348f54896fdc02
  - agent b25d2d6e-b20f-471f-99dd-71ea1b3a1f0e
repro: Original recorded interpreter DOM and encoded verifier request/response; no model replay
status: open
---

## Problem

Original It20 BU080r1 job r001-j0010 joined at 19:07:12.682507Z with
benchmark FAILED and infraFALSE. Native status was COMPLETED in224.0seconds.
C1/C2/C3 passed; C4 required the exact reference answer `backtick` and rejected
`grave`. The original prompt asks for the name of the character needed to make
an Unlambda program output “For penguins”, using the shortest name if several
exist. Neither the task nor its supplied reference is changed here.

## Diagnosis

All seven normal manifest members were verified by size and SHA256. Archive
SHA256 is c36ce43283730cd0f2a4558b8f805886adc8d2fd4de70815bcf0d797aa3c194d;
manifest SHA256 is 3726d0cb37233b6b009b4d270bb4291fa514e19bf4dbc5d0127c38aa3d7302f6;
run JSON SHA256 is a27d53ded51de957acc7c2b1f80c7006b31c546e2d44fee7c514d0551205c4b9.
Execution provenance binds the original unpatched source above. Its BU080
catalog entry contains both the shortest-name clause and the exact C4 reference.

Recorded message44 contains the interpreter DOM at https://inazz.jp/unlambda/:
the code textarea contains the added backtick and the output is “For penguins”.
Message45 then explicitly compares the names “grave” and “backtick”. Message50
contains the final Bing DOM, whose generated answer calls “grave” the shortest
recognized name for U+0060. This is captured search-page content, not independent
verification of its lexical claims or linked sources. No website was revisited.

The original encoded browser-verifier request retains the full shortest-name
goal and that final naming DOM. Request payload SHA256 is
6a647a7abd1f79f55ffc5d5466b2744375f28cc8635f5598135f1890a700fe44.
Its actual response payload SHA256 is
666d4e9910beaca721e17af466538f96a5c450c29572aeb5464fa37a4dd9b33a:
`output.correction_text="grave"`, `task_completed=true`, `score=1.0`.
The response reasoning cites both the interpreter test and the naming result.
Messages64 and66 retain `grave`; there is no demonstrated downstream substitution.

The recorded declared evaluator accepts completion, requested format/substance,
and consistency with captured evidence in C1–C3. C4 rejects the name against
`backtick`. Raw declared-judge HTTP request parity was not independently
established. This identifies a semantic name/reference disagreement; it does
not establish a grader defect, independently authoritative synonym equivalence,
or a runtime transport failure.

Two archive searches used backtick/grave/reference mismatch and shortest-name/
synonym/fixed-reference vocabulary. The prior BU077 prediction/reference case
and BU079 unit-selection case, including their Solution and Human feedback,
were read. They are comparators for retained evidence and differing decisions,
not proof that this distinct character-naming incident shares their cause.

## Solution

OPEN: no safe general deterministic runtime repair is established. The actor
and verifier received the relevant task clause and naming evidence. Forcing
`backtick`, normalizing this synonym, suppressing the search result, rewriting
the prompt, or weakening the exact-answer criterion would change the task or
acceptance contract rather than prove a general repair. No runtime, schema,
model route, task, evaluator, budget or cap was changed. No new model or remote
call ran. Original FAILED/infraFALSE and native COMPLETED remain unchanged.

## Human feedback

The coordinator required original member/source verification and the actual
actor, schema and verifier boundary before clustering, with a bounded intake
and no answer-specific patch. Historical future branches were preserved.
Tokens UNMETERED.

## Reusable lesson

An observed character and a chosen character name are separate claims. Preserve
the original naming instruction, tested program, captured lexical evidence,
verifier decision and exact-reference rubric before attributing disagreement
to lost evidence or proposing an answer rewrite.
