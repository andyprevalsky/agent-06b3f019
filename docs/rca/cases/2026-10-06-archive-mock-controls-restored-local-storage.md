---
id: 2026-10-06-archive-mock-controls-restored-local-storage
date: 2026-10-06
title: Archive interleaving controls inherited local storage after the preceding fixture restored its environment
surface: harness
component: trace-archive-batch-unit-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: trace-archive-batch.test.ts installed its S3 interleaving sender outside the offline R2 withEnv scope
symptoms:
  - fixture must start the actual second publication
  - an unrelated root must finish while the first root owns its publication lock
  - Missing expected rejection.
tags:
  - archive
  - deploy
  - fixture-isolation
  - concurrency
sources:
  - PR #1424
repro: back-end/src/tests/unit/trace-archive-batch.test.ts
status: open
---

## Problem

The final-source backend coverage run completed 184 API blackbox domains and
252 unit files successfully. The remaining unit file reported one passing
control and seven failures. Those controls had previously passed when their
private runner supplied an offline R2 environment globally. The normal coverage
runner correctly pins archive storage to a local backend.

## Diagnosis

The path was coverage's local archive environment, the first control's temporary
offline R2 scope, restoration of that environment, installation of the sibling
controls' S3 sender, and actual archive publication. The first bad boundary was
the missing storage scope around those sibling controls. Local publication never
entered their S3 hooks, so the required interleavings and destructive mutations
did not occur. This was a fixture defect; the failure does not establish a new
production manifest defect.

The unchanged registered owning file was copied into a private candidate with
the exact final-source providers and locked dependencies. Its native Postgres
locks used a separately owned fixture database in the positively identified
isolated workspace server. With the normal `TRACE_ARCHIVE_BACKEND=local`
environment, the same file produced one PASS and seven FAIL in 10.310 seconds.
After fixing fixture scope, it produced eight PASS in 8.656 seconds. The final
formatted version produced eight PASS in 8.589 seconds. The native command was
`back-end/node_modules/.bin/tsx src/tests/unit/trace-archive-batch.test.ts`, with
both database URLs pointing to that owned local fixture.

All 55 assertions and all nine owning function bodies have identical TypeScript
syntax trees across the repair. No provider, model, benchmark, evaluator, or
production source changed. No external provider requests were made.

Archive searches used `fixture must start the actual second publication` and
`archive unit coverage withEnv TRACE_ARCHIVE_BACKEND local offline R2`.
The October 3 runner isolation case and July 4 writer/reader storage mismatch
case are relatives. The October 3 isolation guard is still correct: weakening
it would let tests write to production storage. This new fixture must declare
its own mocked transport premise instead.

## Solution

Use one shared offline archive environment for both the first control and all
seven S3 interleaving controls through the existing `withEnv` helper. Preserve
the existing sender restoration and native Prisma disconnect. This unifies the
fixture premise without adding a runtime fallback or changing any assertion.

The owning file remains in the existing automatically discovered backend unit
suite run by `/deploy` coverage; no test family or large verification was added.
Independent source review passed. The final normal coverage run is still
pending, so this case remains open until that qualification is complete. These local fixture
results do not claim a fleet speedup or a benchmark outcome.

## Human feedback

The user required quick regression controls to remain cemented in deployment,
avoid unnecessary resets, and preserve actual results. The repair changes only
fixture configuration and retains every acceptance assertion.

## Reusable lesson

Declare each mocked transport's storage environment inside its owning fixture scope instead of depending on the parent runner's environment.
