---
id: 2026-10-29-nested-factory-detail-types-aborted-diagnostics
date: 2026-10-29
title: Nested factory detail types aborted diagnostics
surface: harness
component: factory-diagnostics
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: detail nested values reached object and counter operations without shape checks
symptoms:
  - "AttributeError: list object has no attribute get"
  - "factory-review.test.py"
tags:
  - malformed-input
  - deploy
  - scripts
sources:
  - PR #1627
  - commit 5c2a0834755fda327632f157e8fca2320a185d6f
  - plan:/var/tmp/deploy-1627/5c2-script-boundary-rca/report.md
repro: scripts/tests/factory-review.test.py
status: open
---

## Problem

Nested factory detail types aborted diagnostics. Reported in review5692933428 and reproduced against frozen5c2 source before any temporary production edit.

## Diagnosis

First bad boundary: detail nested values reached object and counter operations without shape checks. 51 tests fail with21 subcase errors before and pass after; malformed-only timing/host stay None. Exact before/after commands and logs are retained under /var/tmp/deploy-1627/5c2-script-boundary-rca. Existing test assertions are unchanged; new tests exercise the actual owning functions. Archive searches and prior related cases were read before the fix.

## Solution

Typed object and string label guards preserve valid measurements and ignore malformed nested values. Full51factory and26receipt owner tests pass in five repeated runs. This is temporary candidate proof, not integration or full-gate proof. Parent owns independent review, source application and full gates, so this case remains OPEN.

## Human feedback

Parent required temporary files only, exact frozen-source before/after evidence, existing owner regression registration, unchanged policies/budgets, nonblank identity, unknown nested data kept unmeasured, and structured BLOCKED on invalid numeric inputs.

## Reusable lesson

Validate the actual input shape before identity joins, measurement aggregation or JSON result publication.
