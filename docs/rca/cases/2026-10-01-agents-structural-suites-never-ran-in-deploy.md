---
id: 2026-10-01-agents-structural-suites-never-ran-in-deploy
date: 2026-10-01
title: Agents structural suites ran only in scripts/test.sh, so layering violations and unregistered tests accumulated on main
surface: harness
component: deploy-structural-gate
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/test.sh and the /deploy Step 4s runner listed agents structural suites by hand, and /deploy listed none of them
symptoms:
  - agents structural suite fails on main but deploy is green
  - test defined but never registered in run_all_tests
  - new structural suite never runs in deploy
tags:
  - structural-tests
  - deploy-gate
  - test-registration
  - layering
sources:
  - commit 4961e488c
  - commit ffe9d29db
  - commit 54dff7e4d
  - PR #1354
repro: agents/tests/structural/structural_test_registration.py
status: fixed
---

## Problem

While validating the deploy-resume fixes, the agents structural suites failed on
`origin/main`. There were cross-domain imports, `helpers/` and `utils/` importing
domains, and an import cycle in browser challenge recovery. The blackbox
registration gate also missed 17 tests that were defined but never run, and
three of them had rotted. `/deploy` was green throughout.

## Diagnosis

`scripts/test.sh` ran a hand-written list of agents structural suites, and the
`/deploy` Step 4s runner ran none. A suite therefore only protected main if
someone ran the full local script. The registration gate inspected
`run_all_tests` only, so suites that delegate to a private helper (for example
`_run_all_tests`) produced false positives that hid real omissions. The deepest
owned cause is that test discovery was a manual list in two places, with no
check that the lists covered the suites on disk.

## Solution

- `scripts/tests/agents-structural.test.sh` globs every
  `tests/structural/structural*.py` and fails if the glob is empty. Both
  `scripts/test.sh` entries and the `/deploy` Step 4s runner call it.
- `structural_test_registration.py` runs the gate with a recording Python stub
  and asserts that it ran exactly the suites on disk. It also asserts that
  `test.sh` routes through the gate.
- The registration gate follows private-helper callees. The 17 tests are
  registered and the three rotted ones repaired. The layering violations are
  cleared (single-home `utils/oai_demo.py`, `utils/kill_switches.py`,
  `PLANNER_MODEL` in `providers/rose/pools.py`, the challenge-url leaf module).

10k agents: not applicable (CI only).

## Human feedback

None recorded. The `/deploy` command file change needs prompt-change approval.

## Reusable lesson

A gate that lists its suites by hand will silently stop covering new ones: glob
the suites and test that the glob ran them all.
