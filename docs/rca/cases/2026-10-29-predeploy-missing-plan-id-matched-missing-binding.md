---
id: 2026-10-29-predeploy-missing-plan-id-matched-missing-binding
date: 2026-10-29
title: Absent predeploy plan identity matched absent binding
surface: harness
component: predeploy-receipts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: missing plan run_id and missing binding plan_run_id compared equal as None
symptoms:
  - "missing run_id projected as SKIPPED_WITH_WARNING"
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

Absent predeploy plan identity matched absent binding. Reported in review5692933428 and reproduced against frozen5c2 source before any temporary production edit.

## Diagnosis

First bad boundary: missing plan run_id and missing binding plan_run_id compared equal as None. 26-test before suite has8failures and4errors across identity/numeric cases; after all26pass. Exact before/after commands and logs are retained under /var/tmp/deploy-1627/5c2-script-boundary-rca. Existing test assertions are unchanged; new tests exercise the actual owning functions. Archive searches and prior related cases were read before the fix.

## Solution

Require plan run_id to be a nonblank string before existing identity joins. Full51factory and26receipt owner tests pass in five repeated runs. This is temporary candidate proof, not integration or full-gate proof. Parent owns independent review, source application and full gates, so this case remains OPEN.

## Human feedback

Parent required temporary files only, exact frozen-source before/after evidence, existing owner regression registration, unchanged policies/budgets, nonblank identity, unknown nested data kept unmeasured, and structured BLOCKED on invalid numeric inputs.

## Reusable lesson

Validate the actual input shape before identity joins, measurement aggregation or JSON result publication.
