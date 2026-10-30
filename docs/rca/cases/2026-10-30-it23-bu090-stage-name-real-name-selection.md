---
id: 2026-10-30-it23-bu090-stage-name-real-name-selection
date: 2026-10-30
title: BU090 returns the real name while exact criterion requires the stage name
surface: agents
component: response-schema-and-answer-selection
classification: unresolved
problem_class: other
first_bad_boundary: Model-authored schema specifies full name and the native verifier selects the real name despite retaining the stage name required by the independent exact criterion
symptoms:
  - "deceased_member_name: Yoon Jae-woong"
  - "Ground truth is satisfied exactly when applicable: J.Yoon"
  - "polar perfect-score failed (3/4 rubrics)"
tags:
  - polar
  - bu090
  - it23
  - naming
  - schema
sources:
  - commit fc00b583e7df7b94d05fdb3442bddd23cd21be8b
  - agent a0bc5582-394f-438c-9d7c-4bf259b55a0f
  - plan:.context/r90/proof.json
repro: none-recorded
status: open
---

## Problem

The original question identifies a band through its vocalist and anniversary
album, then asks the name of a member who died before2023 in the first half of
the year. It23 BU090r1/r001-j0010 ends nativeCOMPLETED182.3s/progress1, but
canonicalFAILED and declared evaluation3/4. C1–C3 pass; C4 requires J.Yoon
exactly and rejects the final Yoon Jae-woong. ProducerinfraFALSE and original
grades remain unchanged. This is not a native execution failure.

## Diagnosis

Archivee3f4d0266d15f2441c8b76ad25ddbfa0860d1e051fc046716de92d772cc3c37c,
manifestb0f07f25d1ec3a8a61e2a6a336f54508d5f5f5ec006f2d7ca00fe61d9b0066f8,
and all seven normal member sizes/hashes independently verify. Run SHA
241761623ccdb520980f3da470e4e921c8fb81dea9e70df09b8da7d2f3803f59 binds
executed sourcefc00b583e7df7b94d05fdb3442bddd23cd21be8b, patch none.

The original user asks for a name, without specifying legal/full versus stage
name. The schema-author response at worker90, dumpb3d1c693aa5a, explicitly
emits one required string deceased_member_name described as “The full name of
the band member who passed away in the first six months of a year before
2023.” The compressed payload hash was checked before decoding; decoded SHA
c0c97b9f6842c7a74cf768791fbebbec50e1bc599e094bab94305e7638054444. The author
reasoning also chooses full name. The earlier2000-token attempt ends at length;
the existing retry produces this complete response. No evidence attributes the
name choice to truncation.

Persisted schema at message6 retains the same description and a value/text
presentation. Exact source helpers.llm._schema_from_generated_model copies the
model-authored description; it does not introduce full name or rewrite aliases.
The captured K-VIBE DOM at message44 explicitly identifies J.Yoon and gives
real name Yoon Jae-woong, age38, with dateMay13,2021. Both designations remain
in the native verifier input. No live article lookup was used.

Raw native verifier output worker7828/dumpeef1d5954acc, decoded SHA
ca17f3a2ba0dccfa951c64799e034c976f1bf16165808ba53e33afbdd1a7cf90,
returns deceased_member_name=Yoon Jae-woong, task_completed=true and score1.0.
Its reasoning explicitly distinguishes the stage name from the real name and
calls the requested full name supported. The child structured response and
root final answer carry Yoon Jae-woong unchanged. The root's completed-child
shortcut accepts the matching required field. There is no observed transport,
parser, finite-node conversion or final-display mutation that drops J.Yoon
from an originally selected answer value.

The independent declared evaluator likewise recognizes the same-person
relationship: C1 end-to-end, C2 format/substance and C3 grounding all pass;
C4 alone requires the exact stage-name string. This records the original
criterion without declaring it defective or changing its outcome. A general
rule choosing legal names, stage names, or all aliases is not established by
this one naming question.

Archive searches covered stage-name/real-name selection and generated-schema
specificity. The BU074 generated-date-bound case was read as a comparator:
it demonstrates why model-authored constraints must be distinguished from
conversion. Here the schema is representable and the chosen real name is
retained in evidence, unlike an impossible string-length constraint. No same
cause or old-fix regression is asserted.

## Solution

OPEN; no deterministic general runtime repair established. Do not hardcode
J.Yoon, rewrite the rubric, force aliases into every name answer, or remove
valid user-requested full-name constraints. No prompt change, model replay,
provider/native/DB call, or speculative regression test was performed.
A useful future investigation would need a general user-intent contract for
name designation and evidence that it preserves other explicit naming tasks.

Final cleanup independently records Tilion session
sess_c3d0eb20572b4d3faa62bd45d77ac215 DELETE204 with root deleted and tree sealed.
The earlier Browser session cleanup failed message does not override the
normal final cleanup receipt. No operational infrastructure stop was inferred.

## Human feedback

The coordinator required original actor/schema/verifier/final evidence before
accepting the evaluator's prose as a cause. Preserve native completion versus
independent criterion failure, immutable grades, and the live source freeze.

## Reusable lesson

A model-authored output description can select one supported designation while
an exact criterion expects another. Trace the original schema and raw verifier
value before attributing that difference to data loss or rewriting evaluation.
