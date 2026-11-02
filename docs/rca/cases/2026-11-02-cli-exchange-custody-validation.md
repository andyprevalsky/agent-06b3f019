---
id: 2026-11-02-cli-exchange-custody-validation
date: 2026-11-02
title: Login code could be consumed before rejecting credential storage location
surface: back-end
component: repo-onboarding
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Credential custody and malformed successful response checks happened too late
symptoms:
  - Login code could be consumed before rejecting credential storage location
  - Credential custody and malformed successful response checks happened too late
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4428865356
  - plan:/project/rose-speed-comparison-20261028/nov2-old-review-cli_ui/followup-cli-regressions/HANDOFF.json
repro: Existing owning suite: repo-onboarding; exact before/after commands and original evidence in linked handoff
status: fixed
---

## Problem

Login code could be consumed before rejecting credential storage location. The substantive October 30 review finding remained present at frozen commit 261c52ff1.

## Diagnosis

Credential custody and malformed successful response checks happened too late. Exact causal controls, original failures, negative controls and their limitations are retained in the source handoff. This record does not convert mocked mechanism proof into a production outcome.

## Solution

Validate outside-checkout storage before exchange and validate the successful response before persistence. Reviewed implementation and registered regressions are integrated; affected owning tests pass; final whole-release gates remain pending. Rejected intermediate C15 and SHA-only watcher candidates remain preserved and were not applied.

## Human feedback

The user authorized fixing the outstanding review findings and finishing deployment. Preserve Freedom, immutable lease/resource ownership, existing assertions and thresholds, and original failed evidence. No provider calls or financial mutations are introduced by the regression fixtures.

## Validation

Backend/frontend type checks and scoped lint pass after mechanical module extraction. Full owning outcomes are recorded separately after execution; deployment is not yet complete.

## Reusable lesson

Preserve the first failure, validate the actual ownership and input boundaries, and register the regression in its existing deploy suite.

Integrated owning validation: proxy and SMS units pass; sandbox grid 12/12, frontend speed 11/11 and agents LLM 260/260 pass. Project-workspace and repo-onboarding pass. Project-maintenance 15/15 and code-sessions 18/18 pass after correcting the new fixtures to restore Prisma delegate methods and isolate owned cron schedules. Original failed fixture run 1793647138-1492164-10198 and successful retry 1793647259-1540581-29396 are retained. This is local fix verification, not production deployment.
