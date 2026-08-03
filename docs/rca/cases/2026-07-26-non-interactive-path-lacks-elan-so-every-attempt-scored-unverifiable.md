---
id: 2026-07-26-non-interactive-path-lacks-elan-so-every-attempt-scored-unverifiable
date: 2026-07-26
title: The Lean toolchain lives on an interactive-shell-only PATH, so the verifier scored every candidate attempt as toolchain-missing
surface: harness
component: auto-math-evolver
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "research/auto-math/scripts/verify-attempt.sh — concluded the toolchain was missing because ~/.elan/bin is wired only by an interactive shell profile"
symptoms:
  - "every attempt scores exit 5 (VERIFIER-UNAVAILABLE)"
  - "`lake` not found when the driver or CI runs `bash script.sh`"
  - fitness signal is uniformly absent across a whole generation
tags:
  - lean
  - elan
  - path
  - non-interactive-shell
  - evaluator
sources:
  - memory:project_millennium_self_improving_harness_xp
repro: none-recorded
status: fixed
---

## Problem

Every verification attempt in the auto-math experiment scored exit 5
(VERIFIER-UNAVAILABLE): `lake` was not found, so no candidate could ever be graded.
The fitness signal was uniformly absent, which is indistinguishable from "no
candidate made progress".

## Diagnosis

`lake` lives in `~/.elan/bin`, which is added to PATH only by an interactive shell
profile. The driver, CI, and any `bash script.sh` invocation run non-interactively,
so they never see it. The verifier trusted its own PATH as evidence that the
toolchain was absent — a silent killer, because the failure mode was a legitimate
exit code rather than an error.

## Solution

`verify-attempt.sh` now prepends `~/.elan/bin` to PATH itself before concluding the
toolchain is missing, so verification works identically under interactive shells,
the driver, and CI.

## Human feedback

None recorded.

## Reusable lesson

Never let a non-interactive runner infer "tool missing" from its own PATH — resolve
the known install location explicitly before reporting a toolchain as unavailable.
