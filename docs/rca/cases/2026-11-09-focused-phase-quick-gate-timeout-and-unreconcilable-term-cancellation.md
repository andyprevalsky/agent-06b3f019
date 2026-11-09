---
id: 2026-11-09-focused-phase-quick-gate-timeout-and-unreconcilable-term-cancellation
date: 2026-11-09
title: Focused repair ran quick checks beside heavy workers, and TERM-cancelled lanes could not be reconciled
surface: infra
component: deploy-test-cycle
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run_phase submitted quick-category gates and local workers together; reconcile had no route for TERM (-15) local workers or a budget-expired quick gate
symptoms:
  - "backend-structural timed_out at 120 s with every completed case PASS"
  - "worker ownership remains; reconcile exact cleanup before recovery"
  - "gates still own unreconciled cleanup; refuse launch: backend-structural"
tags:
  - deploy
  - staged-cycle
  - quick-gates
  - custody
sources:
  - PR #1708 (rounds 42 and 44)
  - commit 2b90d2398d86b22b57d01299fb49cebd12064a71
  - commit 436ee66bfda935024f9e2ec54d024e5c80d5c2ba
repro: scripts/tests/deploy-test-cycle.test.py (Cycle.test_focused_phase_launches_workers_only_after_its_quick_checks, InterruptedLocalRecovery.test_term_cancelled_*), scripts/tests/deploy-test-plan.test.py (InterruptedCustody.test_budget_expired_static_quick_gate_reconciles_only_when_fully_reaped, test_format_quick_gate_term_cancellation_uses_the_static_route)
status: fixed
---

## Problem

PR #1708 round 44 focused all 15 repair gates, including the quick checks
backend-structural, format and typescript. The coordinator launched them beside
13 heavy local workers. backend-structural (57-60 s alone on this system-PG
host) was TERM'd at its unchanged 120 s quick budget with every printed case
PASS; the receipt is UNVERIFIED and `lingering_group`. Earlier, cancelling round
42 with TERM (documented coordinator behaviour) left eight lanes owned: five
supervisors exited before writing their sidecar, three reported orphaned but
reaped children. No reconcile route accepted either shape, so `refresh`,
`resume`, `reexecute` and every relaunch refused.

## Diagnosis

`run_phase` submitted every selected gate at once; only the initial phase ran
quick checks first. `deploy_test_local_cleanup.interrupted_worker` required a
KILL escalation (-9); `deploy_test_interrupted_cleanup.static_worker` accepted
only a cancelled backend-structural receipt. Process records proved every TERM
target reaped and the coordinator's token-bound teardown records were clean with
no survivors, so the resources were released; only the custody route was missing.

## Solution

`run_phase` launches a phase's quick checks first and starts the remaining gates
after they all return; a cancellation during the quick checks launches no
deferred worker. Budgets are unchanged. Local TERM cancellations reconcile from
supervisor wait records (all TERM targets reaped, no KILL, nothing remaining) or,
when the supervisor never wrote them, from the coordinator's clean teardown
record plus the existing quiet-root and listener checks. The static route covers
`format` and a budget-expired quick gate whose receipt and supervisor agree.
Reconciliation grants no test credit; original receipts stay immutable.

## Verification

Red on the previous validators/scheduler, green after; 5/5 consecutive passes;
deploy-test-cycle 287, deploy-test-plan 76, deploy-gates 58 and
deploy-test-worker 158 tests OK. Round 46 then ran backend-structural first
(PASS 57 s) before the workers.

## Human feedback

No new human feedback. The user authorized one more review and then shipping
("u can do one more max, after that just get the deploy in").

## Reusable lesson

Schedule fixed-budget quick checks before heavy workers in every phase, not
only the initial one; the budget assumes an idle host. Every documented
cancellation path (TERM as well as KILL) needs a custody route that proves
release from native records, or a routine cancel strands the whole cycle.
