---
id: 2026-11-02-review-quota-skip-consumed-delivered-review-budget
date: 2026-11-02
title: CodeRabbit quota skip consumed a review it never delivered
surface: harness
component: deploy-review-accounting
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: budget_cycles counted a confirmed quota skip as a delivered review because its merge-accounting result was clean
symptoms:
  - "branch diff differs from the reviewed diff; review the change"
  - "verification review is allowed only after cycle two found a valid issue"
tags:
  - deploy
  - review-accounting
  - provider-quota
sources:
  - PR #1668
  - commit fc19c333d369d011d915b95f634883651730dbe7
repro: python3 scripts/tests/deploy-review-cycle.test.py
status: fixed
---

## Problem

The recording repair received one substantive clean CodeRabbit review. Its
subsequent telemetry batch received an evidenced usage-cap skip, retained as
SKIPPED with a clean result only for merge accounting. Main then advanced with
a backend repair and shared ledgers. Exact binary diff inheritance correctly
refused the changed ledger snapshot. After native ledger stabilization, next
selected verification cycle three, but start refused because cycle two had no
findings. No substantive second review had occurred.

## Diagnosis

Gate: INTRODUCED for the additional deploy configuration/stabilization path;
the bookkeeping defect predates this change but blocks our required deployment.
The first bad boundary is budget_cycles interpreting clean merge accounting
as a consumed review. skip_cycle had already proved no substantive review
existed and recorded the exact HEAD quota comment and non-success check.
The original native refusals and source remain in the private deploy report.
This does not concern or release the assigned recording test.

The unchanged permanent regression fails twice against original source and
passes against the candidate. All 36 existing and added review lifecycle cases
pass, including the fourth-review cap, required second-cycle findings, stale
quota evidence, substantive-review rejection and duplicate-HEAD guards. The
initial isolated test-copy attempt omitted deploy.md; that fixture-only error
was retained and corrected before the complete RED/GREEN comparison.

## Solution

Exclude only completed clean, skipped, usage-cap dispositions from delivered
review budget. Preserve every ledger entry and its evidence. A later HEAD
retains the unused review position and must receive its own substantive review
or fresh exact-HEAD quota evidence. Existing review caps and findings guards
stay unchanged. Skips also no longer contribute to the three-delivered-round
finding-deferral authorization. No production state was manually edited, no
review was called PASS, and no budget was reset or increased.

The provider's unavailable review remains an explicit risk and final external
alert. The original recording repair remains subject to its unchanged owning
publisher invocation and complete deployment acceptance.

## Human feedback

The user requires autonomous completed deployment, truthful native receipts and
no fabricated PASS or weakened acceptance. The standing review policy explicitly
makes confirmed provider usage exhaustion nonblocking and requires keeping its
unavailable outcome distinct from a substantive review.

## Reusable lesson

Keep merge disposition separate from evidence that a review actually occurred.
