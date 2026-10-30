---
id: 2026-10-29-predeploy-exit-zero-hid-provider-resource-skip
date: 2026-10-29
title: Predeploy summary inferred full pass from zero exit despite skipped provider task
surface: harness
component: predeploy-terminal-receipt-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: predeploy_metrics.write_run_summary labels exit zero passed without inspecting planned task terminal receipts
symptoms:
  - predeploy summary status passed while mass-agent task status SKIPPED
  - Compute token pool exhausted or cooling down
sources:
  - PR #1627
  - commit b81ef3af99857012771aa7b53bf84f7a9c00d6fd
  - plan:/var/tmp/deploy-1627/provider-resource-policy-rca/report.md
tags:
  - predeploy
  - provider-quota
  - skipped
  - terminal-receipts
repro: scripts/tests/predeploy-receipts.test.py
status: open
---

## Problem

Historical predeploy run20261029-005028-1733152 returned exit0 and summary passed.
Its exact nine planned tasks contained eight passing results and one mass-agent
SKIPPED for exhausted/cooling Codex compute tokens. The user explicitly authorized
confirmed third-party credit or storage exhaustion skips with a final warning.
Such a skip must not be counted as a pass or block the deployment.

## Diagnosis

The summary producer maps exit0 directly to passed. That boundary carries no
per-task inventory or skip distinction. The report-card drops the skip reason;
the raw task receipt retains it. A same-assertion check rejects the historical
summary and accepts the explicit eight-pass/one-skip projection. The source of
the mass receipt is unrecorded and remains unknown.

## Solution

TEMP operational validator joins explicit planned tasks, raw/card receipt hashes,
terminal evaluator status, timestamps and exact existing cleanup receipts.
Trusted operator confirmations bind a specific provider exhaustion cause to
one task and immutable receipt; free log text never determines classification.
It emits SKIPPED_WITH_WARNING with provider/test/reason/time, preserving original
status and unknown source. Unknown causes, incomplete coverage and cleanup
failures block. Seventeen local regression methods pass five times; only the
new existing-domain registration entry was exercised, not full gates.
Parent owns review, source application, operational invocation wiring and final
warning presentation. Those pending steps keep this case OPEN.

## Human feedback

Parent required canonical terminal evaluator status, ordinary-pass source proof,
explicit planned run/time/receipt binding, exact cleanup receipt validation,
and malformed-input rejection. Native lifecycle ACTIVE is not a failed evaluator:
actual chat-mode has benchmark_status PASSED and native status ACTIVE.

## Reusable lesson

Determine deployment policy from complete terminal task receipts and explicit scoped exceptions rather than aggregate process exit status.
