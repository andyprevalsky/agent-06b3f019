---
id: 2026-10-28-factory-ledger-invalid-epochs
date: 2026-10-28
title: Malformed ledger epochs reached sorting and diagnostics
surface: harness
component: factory-review
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_ledger_rows called row_key before validating epoch fields
symptoms:
  - "invalid epoch aborts factory review before diagnostics"
  - "PR1627 c8 review regression"
tags:
  - deploy
  - scripts
  - regression
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: scripts/tests/final-review-script-regressions.test.py
status: open
---

## Problem

invalid epoch aborts factory review before diagnostics. Review finding was verified against frozen c8 source and executed local reproduction; it is not adopted on review text alone.

## Diagnosis

First bad boundary: load_ledger_rows called row_key before validating epoch fields. Owning tests: test_malformed_ledger_rows_rejected_before_sort_and_counted.

Exact before command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/before/scripts/tests/final-review-script-regressions.test.py

The30-test registered suite exits1 with13failures and8errors including subtests, wall0.4022s. Its unchanged test code executes the identified boundary. Relevant before-1.log, manifest.json and source-proof.json are retained in the parent artifact directory. The runtime-resource case additionally starts a real local child, reproduces supervision failure, and cleans only that exact child in its test finally block.

Archive searches were 'git timeout source metadata unknown memory sampling supervisor' and 'malformed ledger epoch rename old path approval timeout'. These broad results are related guidance, not evidence of recurrence. No exact prior cause was adopted.

## Solution

Validate finite required epochs before row_key and sorting; preserve valid dedup and carry rejected-row count into diagnostics; direct diagnostics callers use the same validator.

Exact after command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/after/scripts/tests/final-review-script-regressions.test.py

All30tests pass in five consecutive runs, process0.4032–0.4137s. Tests are byte-identical between before and after, with the pre-existing git-argv expectation strengthened to include --no-renames on both sides. Existing final-review-script-regressions gate discovers the additions; no new gate. This is temporary-candidate causal proof, not full deployment proof. Independent review, integration and full frozen-source gates remain with the parent. Golden reference: not applicable; no approval-gated runtime/prompt change.

## Human feedback

Parent required temporary copies only; no source, provider, environment, threshold or budget changes; no stale-headroom admission; finite epochs and rejected-row counts; precise before/after proof and OPEN archive. Source-owner review explicitly approved the necessary upstream factory_review.py loader scope.

## Reusable lesson

Preserve unknown evidence as unknown and validate the owning boundary before publishing or acting on it.

## Integration verification

On the canonical integration checkout, the broader factory-review suite exposed its exact coverage-dictionary expectation missing the newly required `rejected_rows` field. The valid fixture now explicitly expects `rejected_rows: 0`, retaining every prior stage/detail/run value and downstream assertion. Original failure is preserved in `/var/tmp/deploy-1627/final-integrated-cycle2/factory-review.log`; all 48 unchanged final tests passed in five consecutive runs after that schema expectation correction. Full final deploy gates remain required.
