---
id: 2026-11-11-completed-review-findings-could-not-be-deferred
date: 2026-11-11
title: Completed third-cycle findings could not receive their authorized deferral
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: override_cycle requires an open cycle after finish records findings
symptoms:
  - no review cycle is open
  - an evidence-backed third-cycle deferral cannot follow finish findings
tags:
  - deploy
  - review
  - evidence
sources:
  - PR #1915
  - commit 4bcda6aa9cb5b7df9467e7fd2940e6638c686dcb
  - plan: .context/rca-playwright/review3-disposition-recovery/packet.json
repro: scripts/tests/deploy-review-cycle.test.py::CompletedFindingsDispositionTest.test_finish_findings_then_override_preserves_original_end_and_prefix
status: fixed
---

## Problem

The actual third CodeRabbit review delivered two findings on the approved source.
After recording `finish --result findings` and answering both comments, the
authorized nonsecurity deferral failed with `no review cycle is open`. The
existing override command required an open cycle even though the documented
workflow first closes the delivered review. The original approval, review,
finding replies, completed check and ledger remained intact.

## Diagnosis

The failure precedes review-evidence validation: `override_cycle` calls
`_open_cycle` unconditionally. Starting another review, resetting the ledger or
relabeling the delivered review would lose its actual history. No supported
completed-findings transition existed. The owning regression fails against the
original source, and replaying the actual captured ledger and GitHub evidence
reproduces the same refusal. This diagnosis does not classify the separate
Playwright production failure or the semantic test failures.

## Solution

Allow only the same final, completed third findings cycle to receive its
evidence-validated overridden disposition. Require the exact prior ledger hash,
intact completed prefix, original verification approval, exact-head review and
review-bound findings, finished check and required finding replies. Recheck the
ledger bytes before writing. Preserve the original findings result and finish
time in explicit audit fields, recording the later disposition time separately.
No cycle is reopened or added; the report states Overridden rather than claiming
a clean native review. Existing open-cycle behavior remains unchanged.

The permanent regression was observed RED before the source fix and the same
owning suite passed all 98 tests afterward. Private replay of the original native
evidence changed from refusal to the authorized disposition while preserving
the prefix, approval and original finish. Controls reject other heads, clean or
unavailable cycles, malformed or changed evidence, missing approval and concurrent
ledger drift. Normal source-bound gates remain required before deployment.

## Human feedback

The user approved one additional verification review for the original frozen
source. This recovery creates no additional review slot or expanded approval.

## Reusable lesson

Keep a delivered review's outcome separate from a later authorized disposition,
and validate their transition without rewriting the original outcome.
