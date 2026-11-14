---
id: 2026-11-08-controller-registry-fixture-omitted-retained-checkout-selector
date: 2026-11-08
title: Merged controller inventory fixture omitted retained warm checkout diagnostic selector
surface: harness
component: cloudbench-controller-registry
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: LocalController.CONTROLLER_PYTEST_KEYWORDS omitted the retained run-cloudbench-controller-local.py warm checkout failure selector
symptoms:
  - LocalController.test_complete_inventory_and_registration selected-pytest command equality failed
  - warm_checkout_failure_preserves_native_exit_and_logs_duration present in runner but absent in expected tuple
tags:
  - deploy
  - merge-integration
  - registry
  - fixture
sources:
  - commit e001301076c6b3ff3c966b841bf6db03edcb4a8e
  - commit 51d5f89918db7fb88fbda33e69ebb9b704b313bf
  - commit 70fb5a05497af53c0204ce8725a80decaed1e02e
  - plan: .context/cli-nov08-round47-failures/deploy-test-worker.log
repro: python3 scripts/tests/deploy-test-worker.test.py LocalController.test_complete_inventory_and_registration
status: open
---

## Problem

The full round47 deploy-test-worker job ran139 tests and failed only the exact
controller registry equality assertion. The actual selected-pytest command
contained the warm checkout failure diagnostic regression, while the pinned
expected keyword tuple did not. All other commands and keyword ordering matched.

## Diagnosis

Gate: INTRODUCED by combining the two parents, bounded to this registry fixture.
The51d5 runner already selected the diagnostic, but51d5 had no exact pinned
inventory test. Main70fb introduced the pinned inventory fixture and its runner
matched it. The prepared merge retained the branch runner selector and upstream
pinned expectation, creating exactly one missing expected keyword. The actual
warm checkout regression exists and exercises one fake fetch command over native
exit codes0,1,124,255, checking duration output without leaking the fixture token.

The original unchanged single test was run on clean e001 and failed. Exact AST
comparison of all three immutable Git trees records the parent distinction;
this is not evidence that the test already failed on51d5. Archive searches for
literal registry/selected-pytest symptoms and behavioral selector drift found
related fixture-contract cases but no same controller pinning incident.

## Solution

Add the existing warm checkout diagnostic selector to the pinned expected tuple
at exactly the runtime selector position. Do not remove runtime coverage or
relax list equality. All original test method ASTs, assertions, twelve-case
inventory, duplicate checks, file existence checks, timeout values and prior
selector ordering remain unchanged. No runtime file changes.

The identical single test is red before and green after. The LocalController
family and the selected warm checkout regression are additional owning controls;
full worker-suite receipts are saved in the isolated clone's
.context/round47-registry and the parent result report. This case remains OPEN
until independent review and parent combined-source/native gate validation.

## Human feedback

The user required a narrow isolated repair with unchanged assertions and selector
coverage, preserving every original failure, resource owner and financial debt.
No canonical or active-worker source, dependencies or native state were changed.

## Reusable lesson

When integrating an exact registry-pinning test with a branch that adds coverage,
compose its expected ordered inventory with the retained runtime selector rather
than removing the selector or weakening equality to a subset comparison.
