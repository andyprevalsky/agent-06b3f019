---
id: 2026-10-05-review-budget-fixture-real-clock
date: 2026-10-05
title: A simulated review-budget control depended on host elapsed time
surface: harness
component: deploy-command-fixtures
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the fake reviewer consumed a real fifty-millisecond budget before its expected second call
symptoms:
  - "test_budget_exhausted_inside_gh_reports_the_review_timeout"
  - "1 != 2"
tags:
  - deploy
  - fixture
  - verification
sources:
  - commit 7695d9bd9819c6c8bf3d87ce9c039e3c5535a5a4
repro: scripts/tests/wait-for-code-review.test.py::ReviewWaitTest.test_budget_exhausted_inside_gh_reports_the_review_timeout
status: fixed
---

## Problem

The requested fresh deploy gates exposed this fixture defect. Original failed
receipts remain private under `.context/deploy-runs/pr1410-finalize-20261005/`.
They do not receive successful deployment or fleet acceptance credit.

## Diagnosis

The deploy gate observed one fake reviewer call where the owning control
required two. Its fifty-millisecond simulated review budget used real monotonic
time, so scheduling between the first and second calls changed the scenario.

Archive searches covered fixture host deadlines, simulated review clocks, and
finish/admission state. Similar observer and discarded-inner-evidence cases
were leads; they do not establish this incident's cause.

## Solution

Control the fixture clock and advance it inside the fake second query instead
of sleeping. Preserve the tiny simulated budget, exact two-call assertion, and
TimeoutError with last state PENDING. No production reviewer timeout changes.

The canonical command and owning controls are rerun with unchanged semantic
outcome assertions. Product runtime, prompts, evaluators, benchmark definitions,
7200-second normal backstops, and existing 100/50-task evidence are unaffected.
There is no product cost at 10,000 agents. Independent adversarial review checks
actual private failed/green receipts and fixture cleanup ownership.

## Human feedback

The user requested liberal infrastructure observation budgets, compact permanent
deploy regression coverage, and preservation of completed fleet evidence.

## Reusable lesson

Verify the owned outcome with deterministic scenario inputs and generous host observation guards.
