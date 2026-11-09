---
id: 2026-11-08-semantic-reporter-merge-broke-wiring-contract
date: 2026-11-08
title: Semantic reporter composition broke an unchanged wiring contract
surface: front-end
component: semantic-reporters
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/scripts/run-semantic-tests.sh reporter assembly
symptoms:
  - The gate-progress structural assertion failed after native evidence and live progress were merged
  - expected semantic runner to contain the progress reporter assignment
tags:
  - deploy-validation
  - merge-composition
  - regression
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: front-end/src/tests/structural/gate-progress.test.ts
status: fixed
---

## Problem

The gate-progress structural assertion failed after native evidence and live progress were merged.

Critical path: reporter configuration → optional progress initialization → optional native augmentation → Playwright argv → structural contract.

## Diagnosis

The merge preserved both runtime reporters but replaced the upstream literal progress initialization with an append expression. The unchanged structural test therefore failed. This did not prove that live progress output was missing at runtime. A neighboring argument fixture also inherited the deploy worker’s progress variable while asserting the no-progress mode.

The unchanged failed Vitest case reproduced the literal-assignment failure under the canonical supervisor, then passed after the runner repair. All 14 reporter tests passed. Running the unchanged semantic shell suite with a real progress environment separately reproduced the fixture’s inherited-mode failure. Explicitly clearing that variable only for its existing four no-progress fixtures preserved every original assertion; a separate eight-combination matrix covered all/named selection, optional native evidence and optional live progress. The identical shell command then passed with quiescent supervisor cleanup.

The original full-gate UNVERIFIED results remain unchanged. Owning results prove
these repairs only; the new committed source still requires normal gate validation.
Private RED/GREEN and supervisor receipts are retained in round48-operational-owning.

## Solution

Initialize the upstream progress reporter conditionally before appending optional native JSON and lifecycle reporters. Preserve output paths, overwrite rejection, argv quoting, workers and old-Bash empty-array handling. Keep test-mode inputs explicit and test both reporters together.

## Human feedback

Finish the whole-devbox release and ordinary phone/Google acceptance. Preserve
all original failures and checks, Freedom, phone state, and production environment;
never use a diagnostic pass as production or whole-gate acceptance.

## Reusable lesson

Merge composition must preserve both executable behavior and its owning contract; environment-sensitive argument fixtures must declare the mode they assert.
