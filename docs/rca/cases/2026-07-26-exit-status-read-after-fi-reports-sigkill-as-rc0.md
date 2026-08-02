---
id: 2026-07-26-exit-status-read-after-fi-reports-sigkill-as-rc0
date: 2026-07-26
title: run.sh read `$?` after `fi`, so a SIGKILLed seed reported rc=0 and destroyed the only signal
surface: infra
component: run-sh
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: scripts/run.sh — `$?` sampled after the closing `fi` of the seed block
symptoms:
  - run.sh reports "rc=0" for a seed the kernel SIGKILLed (137)
  - run looked like "stuck in queue" for 40 minutes instead of "OOM-killed"
  - benchmark slice returns no verdict with no failure cause anywhere in the logs
tags:
  - bash
  - exit-code
  - observability
  - cloudbench
  - sigkill
sources:
  - PR #909
  - commit de8a81f1b
repro: scripts/tests/run-seed-exit-code.test.sh
status: fixed
---

## Problem

When the DB seed was OOM-killed on cloud bench guests, `run.sh` reported every
one of those kills as `rc=0`. The operator-facing signal at the exact place a
human reads it said the seed succeeded. The run therefore looked like "stuck in
queue" for 40 minutes instead of "OOM-killed", and the real exit status (137) was
nowhere in the artifacts.

## Diagnosis

`run.sh` sampled `$?` **after** the closing `fi` of the seed's `if` block. A
completed `if` whose condition was false exits 0, so `$?` at that point reports
the status of the `if` construct, not of the seed command. Every non-zero seed
status — including signal deaths — was overwritten with 0 before it was ever
logged. The deeper cause is that the harness never captured the seed's own status
at the point the seed ran; it inferred it from shell state one construct too late.

## Solution

The seed's own status is captured directly, and signal exits 137/139 are named in
the report rather than surfaced as a bare number. Cemented by
`scripts/tests/run-seed-exit-code.test.sh` — it reports `rc=0` for a SIGKILL on
`origin/main` and passes 5/5 post-fix — and registered in
`run-deploy-structural-gates.py` so `/deploy` runs it.

## Human feedback

None recorded.

## Reusable lesson

Never read `$?` after a compound construct in bash — capture a command's status
immediately after the command itself, and name signal exits (137/139) explicitly
so an OOM kill can't masquerade as success.
