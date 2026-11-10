---
id: 2026-11-02-template-existence-failure-finalization
date: 2026-11-02
title: Template existence rejection bypassed per-entry finalization
surface: back-end
component: sandbox-size-templates
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Template.exists rejected outside the per-entry catch while other provider work remained outstanding
symptoms:
  - Template existence rejection bypassed per-entry finalization
  - Template.exists rejected outside the per-entry catch while other provider work remained outstanding
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4428865307
  - plan:/project/rose-speed-comparison-20261028/nov2-old-review-cli_ui/HANDOFF.json
repro: Existing owning suite: sandbox-size-templates; exact before/after commands and original evidence in linked handoff
status: fixed
---

## Problem

Template existence rejection bypassed per-entry finalization. The substantive October 30 review finding remained present at frozen commit 261c52ff1.

## Diagnosis

Template.exists rejected outside the per-entry catch while other provider work remained outstanding. Exact causal controls, original failures, negative controls and their limitations are retained in the source handoff. This record does not convert mocked mechanism proof into a production outcome.

## Solution

Record the affected entry as failed without rebuilding and join the remaining provider work. Reviewed implementation and registered regressions are integrated; affected owning tests pass; final whole-release gates remain pending. Rejected intermediate C15 and SHA-only watcher candidates remain preserved and were not applied.

## Human feedback

The user authorized fixing the outstanding review findings and finishing deployment. Preserve Freedom, immutable lease/resource ownership, existing assertions and thresholds, and original failed evidence. No provider calls or financial mutations are introduced by the regression fixtures.

## Validation

Backend/frontend type checks and scoped lint pass after mechanical module extraction. Full owning outcomes are recorded separately after execution; deployment is not yet complete.

## Reusable lesson

Preserve the first failure, validate the actual ownership and input boundaries, and register the regression in its existing deploy suite.

Integrated owning validation: proxy and SMS units pass; sandbox grid 12/12, frontend speed 11/11 and agents LLM 260/260 pass. Project-workspace and repo-onboarding pass. Project-maintenance 15/15 and code-sessions 18/18 pass after correcting the new fixtures to restore Prisma delegate methods and isolate owned cron schedules. Original failed fixture run 1793647138-1492164-10198 and successful retry 1793647259-1540581-29396 are retained. This is local fix verification, not production deployment.
