---
id: 2026-11-08-devbox-teardown-test-read-host-cloud-env
date: 2026-11-08
title: devbox-teardown test ran the real script in the host checkout, whose .cloud-env re-exported ROSE_USE_SYSTEM_PG=true and broke the Docker case on every devbox
surface: harness
component: devbox-teardown
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/devbox-teardown.test.sh ran "$ROOT/scripts/devbox-teardown.sh" from the host checkout; the script sources "$ROOT/.cloud-env" after the test's `unset ROSE_USE_SYSTEM_PG`, so a devbox's cloud identity chose system Postgres for the Docker case
symptoms:
  - "FAIL: docker devbox must use the container port: DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria"
  - "devbox-teardown exit=1"
tags:
  - devbox-teardown
  - cloud-env
  - rose-use-system-pg
  - deploy-command-structural
  - hermetic-test
sources:
  - PR #1762 repair devbox (2026-11-08), local run of python3 scripts/run-deploy-structural-gates.py --max-workers 4 on main 4a0e080d7
  - commit 02eb65acf1 (earlier fix that unset an exported ROSE_USE_SYSTEM_PG but not the one .cloud-env re-exports)
repro: bash scripts/tests/devbox-teardown.test.sh in a checkout whose .cloud-env exports ROSE_USE_SYSTEM_PG=true (every cloud-init devbox)
status: fixed
---

## Problem

On the repair devbox, the full structural registry reported `devbox-teardown exit=1`. A standalone run printed
`FAIL: docker devbox must use the container port: DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria`.
The same suite passes on Blacksmith runners.

## Diagnosis

`scripts/devbox-teardown.sh` runs in the devbox being destroyed and sources `$ROOT/.cloud-env` to get the workspace identity; that is
correct production behavior. The test invoked the real script in the host checkout. On a cloud-init devbox, `.cloud-env` contains
`export ROSE_USE_SYSTEM_PG=true`, so the test's `unset ROSE_USE_SYSTEM_PG` (commit 02eb65acf1) was undone inside the script. The
Docker case then took the system-Postgres branch and printed port 5432 instead of the fake container's 55441. Blacksmith has no
`.cloud-env`, which is why it passed there. Red: the unchanged test fails on this devbox, rc=1, with the message above.

## Solution

The test runs the real script from `$WORK/checkout/<checkout basename>`, a view with `scripts` and `back-end` symlinked from the
checkout and no `.cloud-env`. The script's own `ROOT` resolves to that view, so the host's cloud identity cannot decide the cases, while
the code under test and every assertion are unchanged. Green: 5 consecutive passes, plus one pass with `.cloud-env` sourced and
`ROSE_USE_SYSTEM_PG=true` exported in the calling shell. Not agent-scaled (test only).

## Human feedback

None recorded.

## Reusable lesson

A test of a script that sources files from its own checkout must run it from a fixture checkout, because unsetting a variable in the test cannot stop the script from re-reading the host's copy.
