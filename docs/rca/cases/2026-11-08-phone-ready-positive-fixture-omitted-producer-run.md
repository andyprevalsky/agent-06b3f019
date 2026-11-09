---
id: 2026-11-08-phone-ready-positive-fixture-omitted-producer-run
date: 2026-11-08
title: Complete-ready phone unit fixture omitted required producer first-run provenance
surface: back-end
component: phone-connection-state-unit-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: phone-connection-state.test.ts constructed a positive legacy attempt without firstExecutionRunId
symptoms:
  - ready needs current complete configuration including portrait lock
  - actual not_connected expected ready
tags:
  - iphone
  - setup-provenance
  - positive-fixture
sources:
  - commit a2f08090f48ad118bf2fcc71f55b7a011190512d
  - plan:.context/deploy-google400-stabilized/attempts/47/triage/backend-coverage-blackbox/result.json
repro: back-end/src/tests/unit/phone-connection-state.test.ts
status: fixed
---

## Problem

The full backend gate failed its existing READY unit assertion: the DTO returned
`not_connected` rather than `ready`. The other eight unit cases passed. Original
failure evidence remains under the Google400 round51 native-phone records.

## Diagnosis

Gate: INTRODUCED in the whole phone branch relative to main `06416c4f9`.
The positive fixture supplied five producer identity fields but omitted
`firstExecutionRunId`. The reviewed six-field provenance predicate correctly
rejected this malformed state before the later portrait-lock negative ran.
The unit and predicate were unchanged from b5f4 through a2f; that narrower byte
comparison does not excuse their integration mismatch. Archive searches found
related strict-provenance fixtures, but no prior case for this positive unit.

## Solution

Add only the missing synthetic first-run identity to the positive fixture.
Keep the production predicate, expected READY value, missing-portrait rejection
and signed-out projection unchanged. The identical command from `back-end`,
`node --import tsx --test src/tests/unit/phone-connection-state.test.ts`, was
RED (8/9, 435.209 ms) then GREEN (9/9, 516.589 ms). The 21 existing continuity
unit cases also passed. All 39 original assertion calls are AST-identical.
Supervisor receipts are native 1/0 respectively, quiescent, with no orphans,
signals or remaining children. Whole-source normal backend validation remains
required; these scoped results are not deployment or physical acceptance.

## Human feedback

The user requires normal phone and Google acceptance without resetting the
phone or substituting a benchmark. This fixture repair grants no such credit.

## Reusable lesson

Construct positive trusted-state fixtures with every required provenance field instead of relaxing the fail-closed predicate.
