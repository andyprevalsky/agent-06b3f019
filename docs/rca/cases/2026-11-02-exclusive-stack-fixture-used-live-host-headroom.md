---
id: 2026-11-02-exclusive-stack-fixture-used-live-host-headroom
date: 2026-11-02
title: Exclusive-lane scheduler fixture inherited live host headroom
surface: harness
component: deploy-pipeline-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The synthetic test passed --memory-budget-mb 6000 but did not control host_resources; run() intentionally clamps that requested budget to actual startup headroom, observed 3068 MB, below its 4150 MB synthetic smoke reservation.
symptoms:
  - check_exclusive_lane_defers_behind_stack_lane
  - ran.returncode == 0 and receipt["status"] == "passed"
  - big passed after resize while pipeline exited 1
tags:
  - deploy
  - fixture
  - memory
  - scheduler
sources:
  - commit 05449cd2d44b879ec883cfd24aa2a9430da8a811
  - plan:/project/rose-speed-comparison-20261028/nov2-scheduler-rca/HANDOFF.json
repro: python3 scripts/tests/run-deploy-pipeline.test.py
status: fixed
---

## Problem

The owning structural regression exits at its first all-green assertion under concurrent host load despite big passing.

## Diagnosis

Fixture controls declared lane reservations and intended 6000 MB budget, but leaves the other input to min() external. A startup live budget below 4150 refuses smoke; later changing host headroom does not raise the frozen attempt budget. The original TemporaryDirectory /tmp/deploy-pipeline-test-u511jof_ was gone on inspection, so original full receipt and sibling logs were not available. Smoke refusal is directly observed in the preserved controlled reproduction; no claim to recovering the deleted historical receipt.

Original raw log records budget 3068 and big passed. Controlled 3068-headroom reproduction on original test asserts the same failure with smoke failed/refused; candidate supplies synthetic 6000 headroom and unchanged ten assertions pass, including explicit 1839 MB impossible-fit refusal.

## Solution

Artifact-only candidate adds optional synthetic host sampling to test run_driver via child bootstrap; only this owning case uses it, with unchanged max-parallel=0, 6000 MB intended budget and declared(1)-1 refusal budget. Both original 120-second subprocess limits and all ten assertion ASTs are preserved. All child lane commands remain native fake sleep/printf/true processes.

Candidate SHA256 `347eb13b5e2f52aec10a5315d460cfe688516e0fb7a692d45aa0306ae4322c91`. Five focused real-CLI repetitions passed; full integrated suite remains required. All ten assertions and both timeouts are unchanged. Production scheduler code is unchanged.

## Human feedback

User prohibited tracked source/index/commit changes during root frozen 05449 and active G3; authorized only private synthetic reproduction and artifact candidate. No full suite, provider, DB or other agent work.

## Reusable lesson

Synthetic resource tests must control both their requested budget and the host-resource sample that bounds it. Preserve production safety limits.


Integrated validation on 2026-11-02: backend typecheck and scoped lint passed; mobile owning suite passed all 16 tests; the full run-deploy-pipeline owning regression suite passed after both fixture-input repairs. Full release gates and production verification remain separate requirements. Original failures and focused evidence are retained under `/project/rose-speed-comparison-20261028/`.
