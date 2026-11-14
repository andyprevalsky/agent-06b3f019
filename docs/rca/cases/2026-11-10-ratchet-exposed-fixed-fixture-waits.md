---
id: 2026-11-10-ratchet-exposed-fixed-fixture-waits
date: 2026-11-10
title: Merged fixed-sleep ratchet exposed branch fixture synchronization debt
surface: harness
component: deploy-structural-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RatchetCase.test_current_tree_passes compares branch literal waits with the incoming main baseline
symptoms:
  - replay_cli_test.py literal sleeps 1 exceeds baseline 0
  - test_claude_md_replay.py literal sleeps 1 exceeds baseline 0
  - campaign-hub-grouping.test.ts literal sleeps 5 exceeds baseline 2
tags:
  - deploy
  - synchronization
  - regression
sources:
  - PR #1881
  - commit 79e326ef5ce039e269166aa589fb33b25bbb887e
repro: python3 scripts/tests/condition-waits.test.py RatchetCase.test_current_tree_passes
status: open
---

## Problem

The native structural unit failed its original suite and automatic single-test retry. Both Python waits and three excess TypeScript wait sites were introduced by this branch relative to incoming main. Two older TypeScript polls were inherited. The merged ratchet and baseline were unchanged; this is an introduced integration defect. The outer structural receipt remains native exit1, incomplete and UNVERIFIED, with cleanup reported complete.

## Diagnosis

The replay controller and honeypot tests polled using literal sleeps. The fleet threshold fixture waited two seconds and assumed a below-threshold scan had completed; elapsed time could not establish that boundary. The ratchet newly enforces a deterministic-wait policy against existing branch-authored test scaffolding. The original three owning Python and three TypeScript cases passed, showing why their isolated success did not prove compliance with the ratchet.

## Solution

Use the existing canonical condition helpers for controller, recorder and shard readiness. In the synthetic fleet driver, publish a completed-scan acknowledgement and gate the next scan with an explicit FIFO permit. Observe the actual1/40 scan before asserting no cancellation, then publish2/40 and observe the unchanged threshold-stop behavior. Nonblocking permit opening and bounded condition waits prevent a vanished reader from blocking Node. Exact-controller TERM cleanup remains in finally. Ratchet baseline, assertions, production threshold, task definitions and concurrency stay unchanged.

The replay CLI test was outside the agents-pytest discovery globs. Register its exact existing pytest command as a structural gate and assert that registration in the same test file, so a normal deploy runs the regression.

## Verification

The original ratchet assertion is RED. Five unchanged candidate rounds pass the three Python cases, twelve owning/neighbor TypeScript cases and unchanged ratchet. The registration assertion fails against the old registry; the exact registered command collects and passes eight cases in five unchanged runs. Existing selector registration now reports deploy-structural-gates without a selector change. Independent patch review and fresh native source validation remain required before full acceptance.

## Human feedback

The source was required to remain frozen during native gates. A private validation-tree chmod mistakenly followed symlinks and touched source modes; all tracked modes were restored and contents remained unchanged, but ctimes changed. The exact permission-correction record is retained privately. Clean Git status does not establish unchanged filesystem metadata.

## Reusable lesson

Synchronize on an observable completed action, and register tests through their actual execution path. A fixed delay or passing unregistered local test cannot prove that a release invariant is exercised.
