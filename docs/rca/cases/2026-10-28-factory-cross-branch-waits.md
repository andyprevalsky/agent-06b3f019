---
id: 2026-10-28-factory-cross-branch-waits
date: 2026-10-28
title: Factory waits were paired across branches
surface: harness
component: deploy-speed-integration
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Open wait keys omitted branch identity, pairing unrelated starts and finishes.
symptoms:
  - "Interleaved branch waits collapsed to one interval instead of separate5s and7s waits"
  - "_wait_windows"
tags:
  - deploy
  - review-stabilization
sources:
  - PR #1627
  - commit da889f4ecc65ce8c1ba92120d0c9301847a02467
repro: python3 scripts/tests/final-review-script-regressions.test.py
status: open
---

## Problem

Open wait keys omitted branch identity, pairing unrelated starts and finishes.

## Diagnosis

The exact final review and independent triage are retained in
/var/tmp/deploy-1627/final-review-new-findings.json and
final-coderabbit-independent-triage.md. Boundary-specific original/candidate
commands, assertions, outputs, and limitations are retained under
/var/tmp/deploy-1627/final-scripts-rca/. These local artifacts supplement the permanent
owning regression; they do not substitute for full deploy gates.

## Solution

Include branch identity in wait pairing without inventing missing attribution.

The correction was reproduced and independently reviewed outside the frozen integration checkout, then applied after its checks ended. Integrated permanent regression verification and the genuinely fresh full deploy remain required. No original failed receipt is changed to passing.
Status remains open pending those checks. Golden reference is not applicable to
these code and diagnostic changes; no new product prompt approval is inferred.

## Human feedback

Preserve the user-required full final sweep, assertions, budgets, review-cycle
limit, original clocks, exact resource ownership, and Freedom. The prior deploy
is review-unstable after its third cycle. Stabilize as development and begin a
fresh deploy rather than adding a fourth cycle to the blocked run.

## Reusable lesson

Validate the owning boundary with the same before/after regression and retain
failure evidence until the complete new deployment is verified.

## Integration application

Approved correction applied after all frozen da889f4ec lanes became terminal on 2026-10-28. The prior deployment remains review-unstable with Kernel403 failure. Integrated owning repetitions and the fresh full deploy remain required; no case is closed by temporary proof.
