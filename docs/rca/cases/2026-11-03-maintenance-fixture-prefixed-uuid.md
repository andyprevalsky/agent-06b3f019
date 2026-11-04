---
id: 2026-11-03-maintenance-fixture-prefixed-uuid
date: 2026-11-03
title: Maintenance fixture prefixed a UUID rejected by the project API
surface: back-end
component: project-maintenance-regression-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: New fixture assigned 00000000-prefix plus UUID to Project.id before invoking the UUID-constrained project route
symptoms:
  - "blank script update: expected 200, got 404 {\"error\":\"Project not found\"}"
  - PUT project fixture rejected before service lookup
tags:
  - fixture
  - uuid
  - maintenance
sources:
  - PR #1634
  - commit 82d2daa27d7035c644e2f4d9119480560b85d2cb
repro: back-end/src/tests/blackbox/project-maintenance-scheduling.cases.ts
status: fixed
---

## Problem

After repairing the three reviewed maintenance defects, the unchanged owning
suite reached the new blank-script HTTP check and returned404. Backend trace
at2026-11-03T03:18:10.244Z recorded the prefixed ID and a7ms404 response.
The original production defects had been independently reproduced before
runtime edits; this subsequent failure was in the added fixture.

## Diagnosis

The fixture retained an ordering prefix after moving scheduler isolation into
connection-local tables. The resulting identifier is not a UUID.
projects/routes.ts validates every project ID with types.ts projectIdSchema,
which correctly returns404 on that invalid path. SQL fixture creation accepts
arbitrary strings, so it could not expose the contract mismatch earlier.
Searches: `fixture prefixed UUID project not found` and
`invalid identifier fixture uuid`. The October1 composite-evidence UUID case
is a relative with a different producer and signed-share consumer, not the
same recurrence.

## Solution

Use the ordinary randomUUID without a prefix. Keep the route validator,
expected200, every scheduling assertion, and transaction isolation unchanged.
The identical three-domain owner command is rerunning; original404 and all
other results remain preserved in nov3-review-fixes/owning-after.log.
Golden reference: not applicable (fixture-only ordinary test correction).

## Human feedback

The user requires fixing failures and completing deployment without weakening
assertions, validators, or caps. No test waiver was requested or applied.

## Reusable lesson

Generate fixtures with the same identifier contract required by every downstream consumer.

## Integrated verification

The same three-domain command failed on the prefixed fixture at the UUID route boundary and passed after replacing only its identifier with randomUUID. Final settings owner7/7, admin-health9/9, maintenance15/15. Every original assertion and route validator remains unchanged. Raw evidence: `nov3-review-fixes/owning-after.log` and `owning-after-uuid.log`.
