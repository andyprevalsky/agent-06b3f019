---
id: 2026-11-10-live-probe-registration-omitted-incoming-probes
date: 2026-11-10
title: Native live-probe registration did not include two merged probes
surface: harness
component: deploy-live-probes
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: DeployLiveProbeTests.test_native_plan_registration_and_portable_recipe expects five cases from a seven-case producer
symptoms:
  - expected five live-probe cases but actual plan contains seven
  - portable alternate-root recipe raises ValueError for two global-root probes
tags:
  - deploy
  - native-evidence
  - portable-recipe
sources:
  - PR #1881
  - commit 79e326ef5ce039e269166aa589fb33b25bbb887e
repro: python3 scripts/tests/deploy-live-probes.test.py
status: open
---

## Problem

The original twelve-test native suite and automatic single-test retry failed the registration assertion. Our native-adapter change introduced the five-case test and portable root API. Incoming main added browser-provider-live and report-bug-storage-live; merging both changes retained the outdated expectation. This is an introduced integration defect. The containing structural aggregate remains incomplete and UNVERIFIED; its separate fixed-sleep failure is not waived.

## Diagnosis

The producer correctly registers the aggregate plus six probes. Focused round26 actually selected all seven cases and executed all six individual commands, including the two added probes, with native exit0 and their serial dependencies. The failure is not a missing live execution. The two added probes also use global ROOT rather than the recipe argument, which breaks alternate-workspace path conversion; the new portability assertion reproduces this independently.

## Solution

Assert the exact seven names and preserve the new probes' exact flags, domains, concurrency and dependency order. Use the existing root parameter for their two working directories. Verify both the ordinary and alternate-workspace recipes without changing commands, live acceptance criteria, timeout or selected inventory.

## Verification

The original registration assertion and additional alternate-root assertion each fail on frozen source. All twelve owning tests pass with the external candidate, and the strengthened deterministic registration/portability case passes five unchanged repeats. Original live command logs, dependencies and source bindings are retained. Independent review and fresh full native validation are still required; no old PASS becomes new-source acceptance.

## Human feedback

No change to the intended seven-case contract was requested. Keep the containing incomplete result and the separate structural failure visible.

## Reusable lesson

When merging a portable adapter with newly added commands, reconcile both exact inventory expectations and each command's use of the adapter's workspace argument.
