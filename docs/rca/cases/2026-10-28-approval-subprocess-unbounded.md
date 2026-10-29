---
id: 2026-10-28-approval-subprocess-unbounded
date: 2026-10-28
title: Approval subprocess calls had no finite timeout
surface: harness
component: deploy-approval-batch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_approval_batch.py _git and run_guards invoked subprocess.run without timeout
symptoms:
  - "Approval guard can hang indefinitely"
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

Approval guard can hang indefinitely. Review finding was verified against frozen c8 source and executed local reproduction; it is not adopted on review text alone.

## Diagnosis

First bad boundary: scripts/deploy_approval_batch.py _git and run_guards invoked subprocess.run without timeout. Owning tests: test_approval_git_timeout_is_bounded_and_typed and test_approval_guard_timeout_is_bounded_and_typed.

Exact before command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/before/scripts/tests/final-review-script-regressions.test.py

The30-test registered suite exits1 with13failures and8errors including subtests, wall0.4022s. Its unchanged test code executes the identified boundary. Relevant before-1.log, manifest.json and source-proof.json are retained in the parent artifact directory. The runtime-resource case additionally starts a real local child, reproduces supervision failure, and cleans only that exact child in its test finally block.

Archive searches were 'git timeout source metadata unknown memory sampling supervisor' and 'malformed ledger epoch rename old path approval timeout'. These broad results are related guidance, not evidence of recurrence. No exact prior cause was adopted.

## Solution

Both boundaries supply300seconds and convert TimeoutExpired to BatchError; no approval or digest is forged.

Exact after command:
python3 /var/tmp/deploy-1627/c8-scripts-rca/after/scripts/tests/final-review-script-regressions.test.py

All30tests pass in five consecutive runs, process0.4032–0.4137s. Tests are byte-identical between before and after, with the pre-existing git-argv expectation strengthened to include --no-renames on both sides. Existing final-review-script-regressions gate discovers the additions; no new gate. This is temporary-candidate causal proof, not full deployment proof. Independent review, integration and full frozen-source gates remain with the parent. Golden reference: not applicable; no approval-gated runtime/prompt change.

## Human feedback

Parent required temporary copies only; no source, provider, environment, threshold or budget changes; no stale-headroom admission; finite epochs and rejected-row counts; precise before/after proof and OPEN archive. Source-owner review explicitly approved the necessary upstream factory_review.py loader scope.

## Reusable lesson

Preserve unknown evidence as unknown and validate the owning boundary before publishing or acting on it.


## Follow-up: descendant cleanup after bounded timeout

The first temporary timeout fix used subprocess.run, which bounded the shell but left its child alive. Parent proof parent-guard-timeout-proof.json measured0.202s and a still-sleeping child. The same incident remained open; it was not split into another case.

Revised _run_guard owns a fresh session, applies300s communicate, exact-group TERM with1sgrace, unconditional exact-group KILL and1s bounded final drain/reap, then raises BatchError. It closes capture pipes and reports cleanup timeout explicitly. No broad process matching or unbounded wait.

Exact unchanged new regression command before:
python3 /var/tmp/deploy-1627/c8-scripts-rca/rejected-guard/scripts/tests/final-review-script-regressions.test.py

After:
python3 /var/tmp/deploy-1627/c8-scripts-rca/after/scripts/tests/final-review-script-regressions.test.py

The31-test suite fails only its real TERM-ignoring grandchild test before (exit1,0.721s), then passes five times (exit0,1.7158–1.7246s). Existing other30test proof remains preserved. Status stays OPEN pending source-owner review/application/full gates.
