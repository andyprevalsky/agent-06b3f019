---
id: 2026-11-02-maintenance-clean-template-local-work
date: 2026-11-02
title: Maintenance restored session-only commits and stash state into template builds
surface: back-end
component: project-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Fresh maintenance used ordinary local-work restore and failed to scrub generated refs and stashes
symptoms:
  - Maintenance restored session-only commits and stash state into template builds
  - Fresh maintenance used ordinary local-work restore and failed to scrub generated refs and stashes
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4428865259
  - plan:/project/rose-speed-comparison-20261028/nov2-old-review-backend/SUPPLEMENTAL-HANDOFF.md
repro: Existing owning suite: project-maintenance; exact before/after commands and original evidence in linked handoff
status: fixed
---

## Problem

Maintenance restored session-only commits and stash state into template builds. The substantive October 30 review finding remained present at frozen commit 261c52ff1.

## Diagnosis

Fresh maintenance used ordinary local-work restore and failed to scrub generated refs and stashes. Exact causal controls, original failures, negative controls and their limitations are retained in the source handoff. This record does not convert mocked mechanism proof into a production outcome.

## Solution

Disable local-work replay only for maintenance and selectively remove generated refs and stash entries while preserving ordinary restore and full-bundle fallback. Reviewed implementation and registered regressions are integrated; affected owning tests pass; final whole-release gates remain pending. Rejected intermediate C15 and SHA-only watcher candidates remain preserved and were not applied.

## Human feedback

The user authorized fixing the outstanding review findings and finishing deployment. Preserve Freedom, immutable lease/resource ownership, existing assertions and thresholds, and original failed evidence. No provider calls or financial mutations are introduced by the regression fixtures.

## Validation

Backend/frontend type checks and scoped lint pass after mechanical module extraction. Full owning outcomes are recorded separately after execution; deployment is not yet complete.

## Reusable lesson

Preserve the first failure, validate the actual ownership and input boundaries, and register the regression in its existing deploy suite.

Integrated owning validation: proxy and SMS units pass; sandbox grid 12/12, frontend speed 11/11 and agents LLM 260/260 pass. Project-workspace and repo-onboarding pass. Project-maintenance 15/15 and code-sessions 18/18 pass after correcting the new fixtures to restore Prisma delegate methods and isolate owned cron schedules. Original failed fixture run 1793647138-1492164-10198 and successful retry 1793647259-1540581-29396 are retained. This is local fix verification, not production deployment.
