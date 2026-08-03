---
id: 2026-07-24-max-turns-envelope-conflated-with-artifact-completeness
date: 2026-07-24
title: Requiring subtype=success before the artifact gates threw away 81 turns of real RCA work on error_max_turns
surface: infra
component: auto-rca-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify-investigator-run — it required Claude transport `subtype=success` before trusted artifact gates could run, with no checkpoint in between
symptoms:
  - "error_max_turns" rejected despite "num_turns: 81"
  - Auto-RCA workflow discards uncommitted RCA work after a max-turn retry
  - "verify-investigator-run" exits 2 on a run that produced real turns
tags:
  - auto-rca
  - max-turns
  - claude-transport
  - checkpoint
  - work-loss
sources:
  - PR #881
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production run `30064099414` executed 81 Claude turns in each investigator, but
both runs returned `error_max_turns`. The validator rejected them on that envelope
alone and the workflow discarded all of the resulting uncommitted RCA work — 81
turns of real investigation thrown away because of how the run ended rather than
what it produced.

## Diagnosis

The lifecycle conflated the Claude _transport envelope_ with _artifact
completeness_. It required `subtype=success` before the trusted artifact gates were
allowed to run, so a run that hit the turn ceiling could never have its output
examined, even though the repro, offline, smoke, and report gates are the actual
authorities on completeness. Compounding this, there was no trusted checkpoint
between the action and those gates, so nothing persisted partial work across a
max-turn retry. The deepest owned cause is a gate ordering that let a transport
signal veto evidence-based verification.

## Solution

Checkpoint primary and retry work _before_ trusted verification so progress
survives max-turn retries, and accept any execution with at least one real Claude
turn — the unchanged repro, offline, smoke, and report gates still own completeness,
so nothing is loosened about what "done" means. Zero-turn results remain rejected.
Local reproduction: baseline `verify-investigator-run` rejected an
`error_max_turns` result with `num_turns: 81` (exit 2); the unchanged fixture passes
after the fix. At 10k agents this adds no shared hot-path state — each workflow
performs bounded, per-agent checkpoints.

## Human feedback

None recorded.

## Reusable lesson

Never gate evidence-based verification on a transport-level status — checkpoint the
work first and let the completeness gates judge the artifacts, so hitting a turn
ceiling costs a retry rather than all progress.
