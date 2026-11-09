---
id: 2026-11-08-standalone-cloud-fixtures-inherit-deployment-authority
date: 2026-11-08
title: Standalone cloud fixtures inherited deployment custody and width
surface: harness
component: deploy-test-worker-fixtures
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Standalone fake request was interpreted under an inherited real DEPLOY_GATE_REQUEST; independent headroom fixture inherited DEPLOY_CLOUD_CONCURRENCY4
symptoms:
  - "historical custody: missing request-owned custody locator"
  - "AssertionError: 16 != 4"
  - "AssertionError: 11 != 4"
  - "AssertionError: 7 != 4"
tags:
  - fixture
  - environment
  - custody
  - capacity
sources:
  - commit 74311e0479c97a8ba770646fa83bf84ba5893081
  - commit 6b505755463d2ef066abdf50978f25616659da02
  - commit 02874c560cb858502e2576780fd2712aaf511045
  - plan:.context/rca-browser-4f77/structural-worker-rca-2141/report.md
repro: scripts/tests/deploy-test-worker.test.py Cloud CloudCampaign CloudSharedProviderHeadroom
status: open
---

## Problem

Original unit156 tests ended9FAIL/7ERROR. Thirteen failures are a standalone fake request inheriting the real deploy authority path; three are fake account-headroom expectations inheriting the real campaign width4.

## Diagnosis

Frozen743 reproduces all16. Removing only each ambient input removes only its cluster; both removed pass36 unchanged methods.02874 passes23 existing cloud methods under the same environment. Incoming6b505 reproduces six custody errors and lacks the restored width cap behavior. See private exact command/exits and source comparisons. Archive searches used literal custody error and ambient fixture/DEPLOY_GATE_REQUEST behavior; the October15 credential scope and October30 sharded fixture cases are relatives, not causal substitutes.

## Solution

Private proposed fixture setup isolation only; retain parent environment restoration and all156 original test bodies. Two added permanent methods poison parent inputs, invoke original native tests and verify restoration; explicit inner width4 remains enforced. Parent integration, review disposition and full native gate acceptance remain pending. No source patch applied by this child.

## Human feedback

Keep original real cloud width4, caps56/140, all tasks/assertions/budgets and live workers unchanged. No sixth automated review or override. Prefer environment-only repair only when supported by the actual normal runner contract; otherwise prepare private source patch and report the consequence.

## Reusable lesson

Isolate standalone fixture authority and capacity inputs within restoring test setup while preserving explicit production guard and limit tests.
