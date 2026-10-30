---
id: 2026-10-29-pipeline-blocked-lanes-recorded-host-samples-every-tick
date: 2026-10-29
title: Blocked pipeline lanes appended host samples every tick
surface: harness
component: deploy-pipeline
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: every headroom-blocked lane appended another full host sample on every scheduler iteration
symptoms:
  - "38 host samples for ten controlled blocked ticks"
  - "PR1627 review385c script regression"
tags:
  - scripts
  - regression
  - deploy
sources:
  - PR #1627
  - commit 385c93722ffbc4f62152ff99a166fa1321ace920
  - plan:/var/tmp/deploy-1627/385c-scripts-rca/report.md
repro: scripts/tests/final-review-script-regressions.test.py
status: open
---

## Problem

Blocked pipeline lanes appended host samples every tick. The review finding was independently reproduced against frozen385c before temporary candidate changes.

## Diagnosis

First bad boundary: every headroom-blocked lane appended another full host sample on every scheduler iteration. Full unchanged46-case regression suite fails before with7failures/2errors; each case exercises the owning implementation. Exact commands and full evidence are in /var/tmp/deploy-1627/385c-scripts-rca/report.md and final-before.log. Related archive searches preceded the proposal; previous mixed credential/quota and typed-data boundary lessons were preserved.

## Solution

Share current admission observations per scheduling pass and retain bounded diagnostic samples. Candidate details and exact patch are in the handoff report. Same46 tests pass five times in1.740–1.761 seconds. No previous assertions, budgets or memory policies changed. This is a temporary proof, not a live/provider result. Parent owns independent review, integration and full-gate reruns, so status remains OPEN.

## Human feedback

Parent required exact before/after proof, temporary-only source copies, existing owner registration, no provider calls, mixed permission failure blocking, fresh admission sampling, and unchanged memory/timeout safety. Broader unrelated AG coverage/local DB/shard/inbox work stayed with other owners.

## Reusable lesson

Share current admission observations per scheduling pass and retain bounded diagnostic samples.
