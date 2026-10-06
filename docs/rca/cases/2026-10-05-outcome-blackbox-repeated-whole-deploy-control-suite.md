---
id: 2026-10-05-outcome-blackbox-repeated-whole-deploy-control-suite
date: 2026-10-05
title: Outcome publication blackbox repeated the entire growing deploy control suite
surface: harness
component: benchmark-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: evaluated outcome blackbox launched the entire compact deployment wrapper within a 60 second subprocess budget
symptoms:
  - agents coverage passed 106 of 107 blackbox domains
  - evaluated_fleet_outcomes_publish_before_teardown raised subprocess.TimeoutExpired
  - standalone compact deployment controls passed while the duplicate invocation timed out under parallel coverage
tags:
  - cloudbench
  - deploy
  - verification
  - subprocess
sources:
  - commit eb0a41fe1bfa68547594cf1c57a399a0522028a5
  - agent /root/deploy_gates canonical agents coverage runtime receipt
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The evaluated-outcome blackbox invoked `benchmark-live-results.test.py`, which
had grown to 151 controls covering unrelated image builds, cache policy,
inventory, ownership and cohort startup. Its standalone deployment invocation
passed in 55.82 seconds. The duplicate invocation inside canonical six-lane
agents coverage, concurrent with backend coverage, exceeded the existing
60-second subprocess budget. The aggregate passed 106 of 107 domains and remains
failed; neither the timeout nor that aggregate establishes a production failure.

## Diagnosis

The exact failed case and source were inspected from the actual final coverage
receipt. Archive searches for duplicated suites, nested pytest and fixture
timeouts found no case that supplies a replacement reproduction. The earlier
source-extraction recurrence explains a separate fixture failure already fixed.

## Solution

The same permanent blackbox now invokes its two existing owning controls
directly: fleet evaluation publication precedes teardown, and the task outcome
is visible before agent/phone cleanup. Both still execute the real helpers and
retain every original outcome/order assertion. The subprocess budget remains
60 seconds. The actual blackbox function passed in 1.912 seconds after this
command-only correction; no task, model, evaluator or runtime timeout changed.

All 151 compact controls remain registered in the always-on structural deploy
gate. This removes their duplicate execution from an unrelated focused blackbox,
not their regression coverage. Private owning evidence is under
`.context/deploy-runs/20261006-024302-65153/` and
`.context/acceptance/startup-speed-20261005/`. Independent review and final affected
coverage remain required before merge.

## Human feedback

Keep verification proportional and cement quick controls in deployment. Run the
whole compact gate once at its owning deployment boundary.

## Reusable lesson

Focused blackboxes
should exercise their behavior directly. Growth in unrelated controls must not
turn a passing behavior into an artificial infrastructure rejection.
