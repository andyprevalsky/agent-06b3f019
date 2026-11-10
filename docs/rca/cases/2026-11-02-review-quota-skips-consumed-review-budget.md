---
id: 2026-11-02-review-quota-skips-consumed-review-budget
date: 2026-11-02
title: Confirmed review quota skips incorrectly consumed delivered review rounds
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: budget_cycles counted completed usage-cap skip dispositions as delivered reviews
symptoms:
  - verification review is allowed only after cycle two found a valid issue
  - A new source could not record its review disposition after two quota skips
tags:
  - deploy
  - code-review
  - quota
sources:
  - PR #1662
  - commit e62978decdfffa17da358783556051440051d47a
  - commit 8d1ba2fe6ca396e1df6952bdf4da19da428b57ad
repro: scripts/tests/deploy-review-cycle.test.py SkipDispositionTest.test_usage_cap_skip_preserves_history_without_consuming_a_review_round
status: open
---

## Problem

CodeRabbit returned confirmed spending-cap skips on the earlier PR1662 heads.
No substantive review ran. Starting a review cycle for the next repaired source
was refused because the ledger treated those skips as clean delivered rounds
and required findings from round two before allowing verification round three.
The recorded provider exceptions themselves were valid and remain unchanged.

## Diagnosis

The native refusal occurred on e62978dec. budget_cycles excluded unavailable
cycles but included every quota skip because its merge-accounting result was
clean. That accounting result is not evidence of a delivered review. The
function originated in 8d1ba2fe6, before this staged-deploy change.

The new unchanged regression fails on the original helper: next_cycle returns
incremental round two after a quota skip instead of initial round one. After
the narrow filter correction it executes two actual skip_cycle calls with
head-bound cap evidence, retains both original entries, accepts a new initial
round, and still refuses to merge its open head. All 35 existing and new tests
pass, including the fourth-delivered-round refusal and substantive-review
checks. Before/after logs are in .context/preparation/review-cap-*.log.

## Solution

Exclude the canonical skipped disposition from the delivered-review budget.
Do not reset or renumber the ledger, change an old result, claim a review ran,
or relax the head-bound provider evidence. The same-head duplicate guard and
real delivered-review cap are unchanged. This enables recording the new
source's actual provider outcome; it does not request retries while the same
provider cap is known. Independent review and the next exact-source disposition
remain required before this record is closed.

## Human feedback

The user requires deployment to continue through quota exceptions without
human intervention, while retaining genuine review results and source-scoped
approval. The policy owner specifically required preserving original skipped
entries and preventing repeated same-source attempts.

## Reusable lesson

Keep merge-accounting dispositions separate from evidence that a review ran;
an evidence-backed quota skip must not spend a delivered-review round.
