---
id: 2026-11-02-review-skips-are-not-delivered-rounds
date: 2026-11-02
title: Review quota skips counted as substantive review rounds
surface: harness
component: review-ledger
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The deferral override counted clean cycles marked skipped as delivered reviews.
symptoms:
  - Review quota skips counted as substantive review rounds
  - The deferral override counted clean cycles marked skipped as delivered reviews.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#pullrequestreview-5742359909
  - plan:/project/rose-speed-comparison-20261028/nov2-final-review-llm-rca/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

The deferral override counted clean cycles marked skipped as delivered reviews.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Exclude explicit skipped dispositions and skip reasons from the override count only. Keep admission, three-cycle cap, old history and explicit prior-round accounting unchanged.

## Validation

The same owning ledger suite fails one of 38 cases before and passes 38/38 after. Legacy cycles lacking skip metadata are not rewritten or inferred.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
