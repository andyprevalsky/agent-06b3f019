---
id: 2026-10-05-controller-fixture-deleted-canceled-evidence
date: 2026-10-05
title: Controller fixture deleted cancellation diagnostics despite requested retention
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: The fixture cleanup retention predicate checked only TEST_FAILED and ignored its nonzero original exit status
symptoms:
  - canceled native fixture exported no original fake state
  - TERM cleanup returned 143 after deleting the requested diagnostics
tags:
  - cloudbench
  - controller
  - fixtures
  - cancellation
  - evidence
sources:
  - commit 07477013e5532725632ea1438237e56a2a945dc6
  - task canonical cloudbench-multi-workstream deployment gate
repro: scripts/tests/cloudbench-controller-linux.test.py ContainerOwnership.test_actual_fixture_cleanup_retains_only_requested_failure_evidence
status: mitigated
---

## Problem

The actual native runner cancellation returned 143 and retired its exact
container while preserving an inert sibling. Its export contained 2,149 files
but no original fake-provider state: the fixture had already deleted that state
inside its signal cleanup. Container storage and retirement alone could not
preserve diagnostics that the fixture deliberately removed.

## Diagnosis

The real cleanup function retained temporary files only when `TEST_FAILED=1`
and retention was requested. Signal traps passed their nonzero original status
to cleanup without setting that separate assertion-failure flag. The actual
extracted cleanup control failed unchanged for TERM143 with retention requested;
normal-success and retention-disabled inverses passed. An independent reduction
also reproduced TERM143 and INT130 deleting their original markers, while the
ordinary assertion-failure inverse passed. The failed integration and reductions
remain privately retained.

## Solution

When `CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=1`, retain temporary diagnostics if
either `TEST_FAILED=1` or the original exit status is nonzero. Preserve process,
Hub and port cleanup before this branch and preserve the original exit status.
The same actual extracted cleanup control then passed, including successful-run
removal and canceled-run removal when retention is disabled. The complete nine
compact controls passed in 0.035 seconds. The unchanged independent cleanup
reduction passed all five cases. The actual repeated TERM/export proof also
passed: exit 143, the exact observed fake-state file retained among 3,251 private
files, exact fixture container absent, and an inert sibling preserved through
retirement. The full normal native gate remains required before closing deployment
evidence. The original failed integration is retained separately.

The next full gate passed concurrent provisioning, then exposed a related
fixture-policy interaction: two deliberate TERM cleanup contracts expected their
child directories to be deleted even while inheriting global failure retention.
Set retention to zero only inside those two intentional child contracts. Keep
their original exit143, PID birth, process-group absence, listener absence, owner
removal and directory-removal assertions. An audit of signal and fixture-root
consumers found no other intentional directory-removal contracts affected by
the inherited flag. The unchanged actual native pending-Hub and prepublication
contracts then passed through the normal dispatcher in 6.212 seconds, preserving
all original process and directory assertions. That bounded run also proved
stop, private export, exact removal and native absence, with all 2,147 exported
regular files at mode 0600. The full native gate remains pending.

## Human feedback

Preserve real failure and cancellation evidence without manufacturing fixture
artifacts or weakening teardown. Change only the owning retention predicate and
retain unchanged funded coverage with explicit source binding.

## Reusable lesson

Failure-preservation flags must account for original process exits as well as
explicit assertion flags. Verify signal cleanup using the actual function and
verify that export contains the original diagnostics.
