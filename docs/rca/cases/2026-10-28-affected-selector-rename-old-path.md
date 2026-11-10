---
id: 2026-10-28-affected-selector-rename-old-path
date: 2026-10-28
title: Rename detection hid deleted paths from affected-test fallback
surface: harness
component: affected-selector
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: changed_files git name-only diff enabled rename detection
symptoms:
  - "rename omitted old.py from changed path list"
  - "PR1627 c8 review regression"
tags:
  - deploy
  - scripts
  - regression
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: scripts/tests/final-review-script-regressions.test.py
status: open
---

## Problem

rename omitted old.py from changed path list. Review finding was verified against frozen c8 source and executed local reproduction; it is not adopted on review text alone.

## Diagnosis

First bad boundary: changed_files git name-only diff enabled rename detection. Owning tests: test_renames_include_old_path_in_all_diff_modes.

Exact before command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/before/scripts/tests/final-review-script-regressions.test.py

The30-test registered suite exits1 with13failures and8errors including subtests, wall0.4022s. Its unchanged test code executes the identified boundary. Relevant before-1.log, manifest.json and source-proof.json are retained in the parent artifact directory. The runtime-resource case additionally starts a real local child, reproduces supervision failure, and cleans only that exact child in its test finally block.

Archive searches were 'git timeout source metadata unknown memory sampling supervisor' and 'malformed ledger epoch rename old path approval timeout'. These broad results are related guidance, not evidence of recurrence. No exact prior cause was adopted.

## Solution

Pass --no-renames to all three diff calls so both old and new paths reach selection.

Exact after command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/after/scripts/tests/final-review-script-regressions.test.py

All30tests pass in five consecutive runs, process0.4032–0.4137s. Tests are byte-identical between before and after, with the pre-existing git-argv expectation strengthened to include --no-renames on both sides. Existing final-review-script-regressions gate discovers the additions; no new gate. This is temporary-candidate causal proof, not full deployment proof. Independent review, integration and full frozen-source gates remain with the parent. Golden reference: not applicable; no approval-gated runtime/prompt change.

## Human feedback

Parent required temporary copies only; no source, provider, environment, threshold or budget changes; no stale-headroom admission; finite epochs and rejected-row counts; precise before/after proof and OPEN archive. Source-owner review explicitly approved the necessary upstream factory_review.py loader scope.

## Reusable lesson

Preserve unknown evidence as unknown and validate the owning boundary before publishing or acting on it.
