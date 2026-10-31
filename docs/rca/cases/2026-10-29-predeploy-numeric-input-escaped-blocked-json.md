---
id: 2026-10-29-predeploy-numeric-input-escaped-blocked-json
date: 2026-10-29
title: Numeric receipt inputs escaped structured BLOCKED output
surface: harness
component: predeploy-receipts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: numeric overflow and nonfinite parsed/output values escaped validation and final JSON serialization
symptoms:
  - "OverflowError: int too large to convert to float"
  - "predeploy-receipts.test.py"
tags:
  - malformed-input
  - deploy
  - scripts
sources:
  - PR #1627
  - commit 5c2a0834755fda327632f157e8fca2320a185d6f
  - plan:/var/tmp/deploy-1627/5c2-script-boundary-rca/report.md
repro: scripts/tests/predeploy-receipts.test.py
status: open
---

## Problem

Numeric receipt inputs escaped structured BLOCKED output. Reported in review5692933428 and reproduced against frozen5c2 source before any temporary production edit.

## Diagnosis

First bad boundary: numeric overflow and nonfinite parsed/output values escaped validation and final JSON serialization. Huge integer,1e999,nonfinite direct caller values,OS timestamp conversion and final CLI serialization reproduce before and pass after. Exact before/after commands and logs are retained under /var/tmp/deploy-1627/5c2-script-boundary-rca. Existing test assertions are unchanged; new tests exercise the actual owning functions. Archive searches and prior related cases were read before the fix.

## Solution

Reject nonfinite JSON numbers, handle numeric and timestamp failures, and guard output serialization. Full51factory and26receipt owner tests pass in five repeated runs. This is temporary candidate proof, not integration or full-gate proof. Parent owns independent review, source application and full gates, so this case remains OPEN.

## Human feedback

Parent required temporary files only, exact frozen-source before/after evidence, existing owner regression registration, unchanged policies/budgets, nonblank identity, unknown nested data kept unmeasured, and structured BLOCKED on invalid numeric inputs.

## Reusable lesson

Validate the actual input shape before identity joins, measurement aggregation or JSON result publication.
