---
id: 2026-11-10-completed-review-findings-lacked-override-transition
date: 2026-11-10
title: Completed review findings could not receive the authorized accounting disposition
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: override_cycle used an open-only lookup after normal finish recorded completed findings
symptoms:
  - "no review cycle is open"
  - "test_completed_findings_override_cli_preserves_original_before_accounting"
tags:
  - deploy
  - review
  - evidence
sources:
  - commit 698d9f478cec10d1437d5847cc47137a25a30a54
  - PR #1905
repro: scripts/tests/deploy-review-cycle.test.py
status: open
---

## Problem

The normal review-finish command recorded the actual third delivered review as completed with findings. The standing three-round nonsecurity disposition remained authorized, but the override command required an open cycle and refused before evaluating its ordinary evidence and reply guards. The permanent public CLI reproduction exited1 with no review cycle is open. No completed findings were erased or manually reopened.

## Diagnosis

The terminal review result and a later merge-accounting disposition are separate facts. Reusing the shared open-only lookup conflated them. No existing supported no-code route could apply the disposition while preserving the actual final findings record: start cannot invent another cycle, skip cannot hide a substantive review, and post-cap recording requires the findings disposition first. This is unrelated to the original chat capture cause or unknown outer gate interruption. The repository's existing three-round authorization remains the authority; no new user approval is inferred.

## Solution

The narrow correction accepts only the latest completed normal-kind findings cycle on the exact requested HEAD, without a prior disposition, skip or exceptional review approval. All existing three-delivered-round, substantive exact-head review, answered-finding and target checks remain in place. Before changing accounting, an append-only receipt stores the complete original findings entry, its canonical hash and original ledger hash. Original result and completion clock remain preserved. Repeated disposition refuses without mutation; archive failure leaves the original result unchanged. The shared start, finish, skip, cap and approval gates are unchanged. Accounting clean does not mean a substantively clean review or another review took place.

The same permanent CLI reproduction fails before and passes unchanged afterward. The complete existing review-cycle suite passed98tests in4.014seconds; negative controls cover wrong head, completed clean/skip/override, exceptional approvals, insufficient delivered rounds, unanswered findings and archive failure. Independent combined source review passed with three targeted override controls and635monitored inputs unchanged. Source freeze, actual disposition and normal deployment remain pending. No source runtime prompts, agent deadlines or financial/provider state changed. Golden reference not applicable: mechanical operator CLI recovery only.

## Human feedback

Preserve real findings, review caps and approval boundaries. Complete the authorized deployment autonomously without inventing an approval or labelling unreviewed source as substantively reviewed.

## Reusable lesson

Preserve a completed review result independently from its later authorized accounting disposition.
