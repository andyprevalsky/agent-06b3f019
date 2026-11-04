---
id: 2026-11-02-code-provider-failed-start-custody
date: 2026-11-02
title: Failed provider-switch startup lost immutable attempt custody
surface: back-end
component: code-sessions
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Inner pause released a stable owner before outer provider rollback, allowing a successor to be confused with the failed attempt
symptoms:
  - Failed provider-switch startup lost immutable attempt custody
  - Inner pause released a stable owner before outer provider rollback, allowing a successor to be confused with the failed attempt
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4428865249
  - plan:/project/rose-speed-comparison-20261028/nov2-old-review-backend/HANDOFF.md
repro: Existing owning suite: code-sessions; exact before/after commands and original evidence in linked handoff
status: fixed
---

## Problem

Failed provider-switch startup lost immutable attempt custody. The substantive October 30 review finding remained present at frozen commit 261c52ff1.

## Diagnosis

Inner pause released a stable owner before outer provider rollback, allowing a successor to be confused with the failed attempt. Exact causal controls, original failures, negative controls and their limitations are retained in the source handoff. This record does not convert mocked mechanism proof into a production outcome.

## Solution

Claim a unique provider-switch owner and retain it through pause and exact-resource cleanup; retain ACTIVE custody after unconfirmed cleanup. Reviewed implementation and registered regressions are integrated; affected owning tests pass; final whole-release gates remain pending. Rejected intermediate C15 and SHA-only watcher candidates remain preserved and were not applied.

## Human feedback

The user authorized fixing the outstanding review findings and finishing deployment. Preserve Freedom, immutable lease/resource ownership, existing assertions and thresholds, and original failed evidence. No provider calls or financial mutations are introduced by the regression fixtures.

## Validation

Backend/frontend type checks and scoped lint pass after mechanical module extraction. Full owning outcomes are recorded separately after execution; deployment is not yet complete.

## Reusable lesson

Preserve the first failure, validate the actual ownership and input boundaries, and register the regression in its existing deploy suite.

Integrated owning validation: proxy and SMS units pass; sandbox grid 12/12, frontend speed 11/11 and agents LLM 260/260 pass. Project-workspace and repo-onboarding pass. Project-maintenance 15/15 and code-sessions 18/18 pass after correcting the new fixtures to restore Prisma delegate methods and isolate owned cron schedules. Original failed fixture run 1793647138-1492164-10198 and successful retry 1793647259-1540581-29396 are retained. This is local fix verification, not production deployment.

## November 3 recurrence: cleanup masked the original start error

Final review5748355636 finding4451807265 showed a rejecting rollback replaced the original create error. The same issue existed in the nonswitched markPaused path. Both cleanup calls now log their failure together with the original error, then propagate the exact original object. Immutable attempt token, native kill confirmation, conditional rollback and retained custody are unchanged. An unconfirmed pause still bypasses outer cleanup.

The unchanged actual-module fake proof failed on both paths before and passes after. Registered code-sessions cases require the original CodeAgentCredentialError identity and retained binding/lease when cleanup fails. Exact receipts: `nov3-final-review-fixes/backend/manifest.json`. Real local-DB owner validation is recorded below when complete.

Integrated verification: admin-health, code-sessions, cli-login and repo-onboarding all passed in the same four-domain command (artifact1793691277-2805897-17819). Existing six-process Kernel local-DB unit passed with one shared remote allocation. Backend typecheck and scoped lint passed. Full new deployment gates and production verification remain pending.
