---
id: 2026-10-29-bu074-generated-date-schema-counted-six-characters
date: 2026-10-29
title: Generated MM/DD/YY output schema counted six characters
surface: agents
component: response-schema-generation
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Captured schema-author response explicitly calls MM/DD/YY six characters and emits minLength=maxLength=6; canonical schema preserves those incorrect bounds
symptoms:
  - "One required string field with a 6-character bound captures this exactly."
  - "final structured response in step 58 and completion output in step 61 return “04/15/,” omitting the year"
tags:
  - polar
  - bu074
  - schema
  - date-format
sources:
  - commit 4016ffaf50aeee0eff1b242d9e348f54896fdc02
  - agent 0b13b9f5-9efe-4de4-a7d3-6ab9f71b124a
  - plan:.context/r69/proof.json
repro: none-recorded
status: open
---

## Problem

It20 BU074r1 asked when Regression was added to the oldest closed
numpy.polynomial issue, in MM/DD/YY. NativeCOMPLETED173.0s but declared
benchmarkFAILED2/4, infra_failure=false; canonical join19:07:20.343219Z.
The correct extracted date04/15/18 appears in the trajectory, while the final
structured value is04/15/. Original outcomes remain unchanged.

## Diagnosis

All seven normal files and archive SHA
7d9aed15fa5ce14243fc0fd2e6c80a383eb5389c2ead8cb496b1cac9f14fe85c
were verified against binding; run SHA
3c1a411f7c47367a8837089e9b498af59e600a80106a47bafbc9435440ec9dcb.
Executed source4016ffaf, patchnone.

Original worker line86 contains a compressed, hash-bound schema-author
response (qwen-3.8-27b). It emits a required string field with minLength6 and
maxLength6, explaining “One required string field with a 6-character bound
captures this exactly.” Its reasoning explicitly says “Actually MM/DD/YY is
6 characters.” The persisted canonical schema retains exactly those bounds
and the MM/DD/YY description. Thus the wrong bound was model-authored;
conversion did not invent it. The schema request is separately retained in
worker line77; both encoded payload hashes were checked before decoding.
Decoded author payload SHA8c81953cea79a779ef19cd423c92fcb7204f250cae73843c464ac16133ad545b;
pre-conversion verifier context artifact SHAe744085c6236b3496ac487e094cca35671a313aa3b28933d268736995a14a7e9.

Original evaluate step16/message47 returns event timestamp
2018-04-15T08:41:56.000Z and regression_label_added_date04/15/18. Browser
verifier reasoning at19:01:44.258867Z repeats the correct date and score1.
The later task_complete structured response contains04/15/, and the root
completion summary passes that value through unchanged. Source
helpers.llm._pydantic_field_bounds copies string bounds into the verifier's
Pydantic Field. _validate_verifier_response rejects output violating bounds;
it does not slice strings. The exact raw verifier response was not located,
so no claim is made about a specific model-versus-parser output mutation.

The author schema is semantically incompatible with the requested format:
eight-character04/15/18 cannot satisfy maxLength6. A six-character value can
satisfy the schema while failing the task. This is not evidence of arbitrary
transport truncation or a regression in the finite-node schema conversion.

Archive searches covered generated schema/date bounds and wrong schema output.
The prior date-only submission and omitted-description cases are relatives,
not proof of the same first-bad boundary.

## Solution

OPEN, no runtime candidate. A task-specific date override or globally removing
valid user constraints would not be a general repair. A deterministic
semantic consistency contract has not been demonstrated for arbitrary
model-authored field descriptions and bounds. No prompt nudge, model change,
criteria adjustment, cap change, new provider call or replay was performed.
Preserve the exact generator response for any later general design/reproduction.

## Human feedback

The coordinator required tracing the original schema-author response before
attributing truncation, preserving valid constraints and all original grades,
and stopping at a concrete OPEN floor without a grounded general mechanism.

## Reusable lesson

Distinguish model-authored contradictory output constraints from conversion or
transport loss before proposing a schema repair.
