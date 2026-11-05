---
id: 2026-11-02-unverified-handoff-could-not-enter-execution-recovery
date: 2026-11-02
title: An incomplete handed-off gate needs execution recovery without a waiver
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: adjudicate rejected every qualified incomplete occurrence without a recovery transition
symptoms:
  - "unverified/incomplete execution cannot be waived as a completed case"
  - "An established NOT_INTRODUCED failure could neither be waived nor enter focused recovery"
tags:
  - deploy
  - failure-attribution
  - execution-evidence
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
repro: scripts/tests/deploy-test-cycle.test.py Cycle.test_handed_off_unverified_execution_requires_full_recovery_not_skip
status: open
---

## Problem

The first real parallel sweep found a pre-existing smoke admission refusal and
four pre-existing frontend fixture failures. Their outer gates were UNVERIFIED:
smoke never executed, and frontend coverage thresholds did not execute. The
canonical failure policy correctly forbids treating missing work as a passed
or waived completed check, but the coordinator also refused recovery unless the
owner falsely changed the evidence-backed attribution to INTRODUCED.

## Diagnosis

Gate: INTRODUCED for this transition defect in the new coordinator. The native
underlying test failures retain their own separate attribution. The unchanged
new regression on e99c91f55 raises ValueError at adjudicate. A private candidate
which permits an explicit execution-recovery request reaches needs-focused-plan
without adding a skip or becoming ready. Four targeted positive/negative tests
pass; the original incomplete-waiver rejection and ordinary skip behavior stay.
Raw logs are retained at .context/recovery-fix/before.log and after.log in the
originating deployment. An initial scratch export omitted deploy-worktree-port.py
and failed import; it is setup evidence only, not the causal before proof.

## Solution

The canonical deploy_failure_report helper validates and records an explicit
execution-required disposition, and its renderer shows the native UNVERIFIED
result and evidence without calling it waived. The cycle consumes this same
decision rather than relabeling the entry locally. For a canonical
NOT_INTRODUCED handoff only, execute_unverified=true sends an
incomplete occurrence to execution required. The failure is preserved, no skip
is created, and focused, full-failed, quick and full-final execution remain
mandatory. Unknown and external-provider entries do not gain this transition.
A completed qualified SKIP continues immediately and never requests a rerun.
The permanent tests pin both sides, the canonical report row, and refusal to
substitute an already-green focused check for the unresolved one. The repair
is integrated; full deployment validation remains pending.

## Human feedback

The user requires continuous deployment work, evidence-backed attribution,
qualified SKIPs without reruns, and real execution of remaining unverified work.
Do not falsify attribution or invent a completed result to advance a state.

## Reusable lesson

Separate ownership of a known defect from the evidence needed for an incomplete
execution. A handoff can waive that defect without proving unexecuted checks.
