---
id: 2026-10-29-selector-head-ignores-exclusions
date: 2026-10-29
title: Explicit revision selection ignored source exclusions
surface: harness
component: deploy-scripts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: changed_files head branch omitted EXCLUDED_TOP filtering
symptoms:
  - "codex and docs/handoffs paths appear in explicit head changes"
  - "PR1627 review 4407990831"
tags:
  - deploy
  - scripts
  - regression
sources:
  - PR #1627
  - commit 0c798385b66e049979c684ed3478940371539e85
repro: scripts/tests/final-review-script-regressions.test.py
status: open
---

## Problem

codex and docs/handoffs paths appear in explicit head changes. Parent assigned review4407990831; this was verified against frozen0c798 and locally reproduced, not accepted from review text alone.

## Diagnosis

changed_files head branch omitted EXCLUDED_TOP filtering. New tests exercise the actual boundary; source-proof.json binds original bytes. All six findings map to six distinct defects, with seven test methods because guard admission covers test-mode and empty-map cases separately. Prior archive searches 'guard override test mode invalid UTF8 diagnostics nonfinite' and 'selector directory roots empty explicit list excluded head' found related guard/ledger/selector guidance, not a proved recurrence.

Exact original command:
python3 /var/tmp/deploy-1627/0c798-scripts-rca/before/scripts/tests/final-review-script-regressions.test.py

It exits1,38tests,11subcase failures plus1error,1.809s process wall. The real temporary Git fixture reproduces non-UTF8 decode failure. No providers or network used.

## Solution

Apply identical excluded-top filtering to explicit head and working-tree change lists.

Exact candidate command:
python3 /var/tmp/deploy-1627/0c798-scripts-rca/after/scripts/tests/final-review-script-regressions.test.py

Same38-test body passes five consecutive times,1.758–1.922s. Existing8-test approval suite additionally passes five times,1.822–3.410s. All assertions and budgets preserved; fake approval fixtures explicitly opt into their permitted test seam. No new gate: existing final-review-script-regressions and deploy-approval-batch gates register both suites. Candidate only; parent independent review/application/full gates pending. Golden reference not applicable; no runtime prompt or schema changes.

## Human feedback

Parent required TEMPONLY work on clean frozen0c798, no source/provider/model/worktree changes, precise issue counts, unchanged owning assertions, and five-run proof. Directory regression was strengthened to exercise actual Selector.select gate identity and no-ALL fallback.

## Reusable lesson

Preserve explicit caller input and reject unverified observations before they can alter validation or measurement results.
