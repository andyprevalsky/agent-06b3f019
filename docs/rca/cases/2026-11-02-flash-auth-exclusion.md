---
id: 2026-11-02-flash-auth-exclusion
date: 2026-11-02
title: Flash auth acquisition ignored the call-scoped Anthropic exclusion
surface: agents
component: llm
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Flash helper acquired and refreshed Claude leases despite the call exclusion
symptoms:
  - Flash auth acquisition ignored the call-scoped Anthropic exclusion
  - Flash helper acquired and refreshed Claude leases despite the call exclusion
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4428865214
  - plan:/project/rose-speed-comparison-20261028/nov2-old-review-backend/HANDOFF.md
repro: Existing owning suite: llm; exact before/after commands and original evidence in linked handoff
status: fixed
---

## Problem

Flash auth acquisition ignored the call-scoped Anthropic exclusion. The substantive October 30 review finding remained present at frozen commit 261c52ff1.

## Diagnosis

Flash helper acquired and refreshed Claude leases despite the call exclusion. Exact causal controls, original failures, negative controls and their limitations are retained in the source handoff. This record does not convert mocked mechanism proof into a production outcome.

## Solution

Pass exclusion through both helpers and restrict fresh and rotation token types. Reviewed implementation and registered regressions are integrated; affected owning tests pass; final whole-release gates remain pending. Rejected intermediate C15 and SHA-only watcher candidates remain preserved and were not applied.

## Human feedback

The user authorized fixing the outstanding review findings and finishing deployment. Preserve Freedom, immutable lease/resource ownership, existing assertions and thresholds, and original failed evidence. No provider calls or financial mutations are introduced by the regression fixtures.

## Validation

Backend/frontend type checks and scoped lint pass after mechanical module extraction. Full owning outcomes are recorded separately after execution; deployment is not yet complete.

## Reusable lesson

Preserve the first failure, validate the actual ownership and input boundaries, and register the regression in its existing deploy suite.

Integrated owning validation: proxy and SMS units pass; sandbox grid 12/12, frontend speed 11/11 and agents LLM 260/260 pass. Project-workspace and repo-onboarding pass. Project-maintenance 15/15 and code-sessions 18/18 pass after correcting the new fixtures to restore Prisma delegate methods and isolate owned cron schedules. Original failed fixture run 1793647138-1492164-10198 and successful retry 1793647259-1540581-29396 are retained. This is local fix verification, not production deployment.

## Recurrence: actual Flash entry points, November 2 final review

At `199d47f6c`, review comments 4446942778 and 4446942792 exposed two gaps in
the preceding helper-only tests: the nonstreaming `call_llm` path referenced
an undefined `_exclude_anthropic_family`, and a streaming call without its
explicit flag could ignore the process-level exclusion. The prior helper
regression did not execute either public call boundary.

The correction resolves process policy in the shared auth helper and passes
process policy from the nonstreaming caller, which has no call-scoped flag.
Streaming retains its call-scoped flag and combines it with process policy.
New registered tests execute actual `call_llm` and
`call_llm_structured_streaming`, mocking only the token broker and provider
transport. Both fail on the old source and pass after the correction.

The full integrated `llm` blackbox domain passes 262 tests in 11.0 seconds.
Raw before/after evidence is in
`/project/rose-speed-comparison-20261028/nov2-final-review-llm-rca/`; the
integrated log is `nov2-final-review-integrated/llm.log` under that project
directory. No live tokens or provider calls were used. Whole-release and
production verification remain separate requirements.
