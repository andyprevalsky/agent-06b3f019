---
id: 2026-07-26-missing-aggregate-olean-scored-as-candidate-build-failure
date: 2026-07-26
title: "`lake exe cache get` reported success without an aggregate Mathlib.olean, so infrastructure damage was scored as the candidate getting worse"
surface: harness
component: auto-math-evolver
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: 'research/auto-math/scripts/verify-attempt.sh — trusted `lake exe cache get`''s "Completed successfully" and returned exit 4 BUILD-FAILED when `import Mathlib` then failed'
symptoms:
  - '`lake exe cache get` prints "Completed successfully" but no Mathlib.olean exists'
  - "every `import Mathlib` fails and scores exit 4 BUILD-FAILED"
  - the evolver reads a broken box as "the harness got worse"
tags:
  - lean
  - mathlib
  - lake-cache
  - evaluator
  - misclassification
sources:
  - memory:project_millennium_self_improving_harness_xp
repro: none-recorded
status: fixed
---

## Problem

`lake exe cache get` can report "Completed successfully" and still leave no
`Mathlib.olean` — per-module oleans ship, but the aggregate roots do not always.
Every `import Mathlib` then fails, and the verifier scored that as exit 4
(BUILD-FAILED), i.e. as a property of the candidate. Infrastructure damage was
therefore fed back to the evolver as "the harness got worse", corrupting the fitness
signal it selects on.

## Diagnosis

The verifier inferred candidate quality from a build failure without first
establishing that the environment could build anything at all. Because the upstream
cache tool exits 0 on a partial fetch, "environment broken" and "candidate broken"
produced the same observable, and the scoring code chose the wrong one. In a
selection loop that misattribution is worse than a crash: it silently rewards or
punishes the wrong thing.

## Solution

`verify-attempt.sh` now asserts `Mathlib.olean` up front and returns exit 5
(infrastructure), NEVER exit 4, when the aggregate olean is absent. `lake build
Mathlib` is the repair but is deliberately not auto-run: measured on a box in that
state it re-elaborated from source (~8.7k modules, hours, gigabytes), so
`install.sh` surfaces it as an explicit opt-in command.

## Human feedback

None recorded.

## Reusable lesson

Before scoring a candidate, prove the environment can build — and give
infrastructure failures a distinct exit code from candidate failures so a selection
loop cannot learn from broken infrastructure.
