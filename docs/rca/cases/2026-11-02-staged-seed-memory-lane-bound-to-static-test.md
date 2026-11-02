---
id: 2026-11-02-staged-seed-memory-lane-bound-to-static-test
date: 2026-11-02
title: Staged seed-memory gate selected a static reference test instead of cold measurements
surface: harness
component: deploy-test-plan
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_plan.py standard_template seed-memory-ratchet command
symptoms:
  - "seed-memory-ratchet command is scripts/tests/seed-memory-ratchet.test.sh"
  - "The selected lane does not execute five cold seeds or enforce measured RSS"
tags:
  - deploy
  - selection
  - seed-memory
  - measurement
sources:
  - PR #1662
  - commit 9dabe67cf7f8a1465864944b9918aa7055ad1369
repro: scripts/tests/deploy-test-plan.test.py Selection.test_standard_template_runs_actual_cold_seed_measurement
status: open
---

## Problem

While provisioning the real selected workers, the generated standard template
bound seed-memory-ratchet to scripts/tests/seed-memory-ratchet.test.sh. That
script verifies the measurement command's text and invariants but never runs
cold seeds. Deploy Step4r separately requires five actual measurements with
fidelity and RSS enforcement. No live gate was counted from this wrong plan.

## Diagnosis

Gate: INTRODUCED. The new standard_template copied the structural registry's
similarly named gate instead of the deployment's runtime command. Path:
standard template -> generated worker recipe -> static command -> potentially
green receipt without actual measurements. The first bad boundary is the
standard template mapping, not the existing static regression or measurement.
Archive search `seed memory actual measurements structural command` returned
related seed measurement cases; this is a new planner wiring error.

The checked-in regression runs the real standard_template and requires the
exact existing five-run measurement command in back-end. On the unchanged
buggy implementation it failed in0.670s, showing the static-test argv. The
identical command passed after the mapping correction in0.368s:

    python3 scripts/tests/deploy-test-plan.test.py Selection.test_standard_template_runs_actual_cold_seed_measurement

Before/after logs live under .context/preparation/seed-command-{before,after}.log
in the originating deployment. Full owning planner suite:15 tests OK in0.332s.
This is causal planner proof; the actual cold measurements are still required.

## Solution

Bind the runtime category to `bash scripts/measure-seed-memory.sh 5 0 0
--enforce-budget` with cwd back-end. Keep the static regression registered in
the separate deploy-command-structural suite. No test count, RSS budget,
fidelity assertion or timeout changes. This removes a substituted command;
there is no fallback or synthesized success. Golden reference: not applicable
(no approval-gated hunk). Independent review and real measurements remain
pending, so the case remains open.

## Human feedback

The user requires full selected categories and their actual validation, with
parallel independent workers; a shorter surrogate is not a completed gate.

## Reusable lesson

Bind each runtime validation category to its actual executable measurement,
not the similarly named regression that checks its wiring.
