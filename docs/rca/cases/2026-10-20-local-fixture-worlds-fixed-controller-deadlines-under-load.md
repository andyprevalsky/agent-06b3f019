---
id: 2026-10-20-local-fixture-worlds-fixed-controller-deadlines-under-load
date: 2026-10-20
title: Local fixture-worlds control failed on a loaded deploy host because its controller exit/readiness deadlines were fixed at 15 s/12 s
surface: harness
component: local-fixture-worlds-test
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: agents/benchmarks/local_worlds_test.py run_case (process.wait(timeout=15), cancel readiness +12 s)
symptoms:
  - "Local fixture world isolation failed; evidence:"
  - "timed out after 15 seconds"
  - "\"fixture_error\": \"TimeoutError\", \"message\": \"cancel readiness\""
tags:
  - benchmark-blackbox
  - fixture-deadline
  - host-load
  - deploy-gate
sources:
  - PR #1558 deploy (combined #1550 + #1551), agents coverage on 2026-10-20 05:45Z
repro: agents/benchmarks/local_worlds_test.py (replay under 32 busy CPU loops)
status: fixed
---

## Problem

On the PR #1558 deploy, the `benchmark` domain of agents coverage failed only on
`local_parallel_fixture_worlds`. The `pair` case raised `TimeoutExpired`
("timed out after 15 seconds") and `cancel-pair` raised `TimeoutError`
("cancel readiness"). The host is an 8-core devbox that was running back-end,
front-end and agents coverage in parallel, at a load average of about 50. The
same domain had passed unloaded at 03:51Z on the same branch.

## Diagnosis

The `pair` evidence shows every task observed, ended and cleaned up. Both
stacks joined about 11 s after the first world was created. Controller start
under load adds to that, so the total exceeded the fixed 15 s
`process.wait`. The cancel case's 12 s readiness window was missed the same
way. No isolation assertion was false; the fixture's observation deadline
expired first. Replaying the fixture alongside 32 busy CPU loops reproduces it:
`exclusive-pair`, `pair` and `cancel-pair` all fail on the 15 s/12 s deadlines.

## Solution

`FIXTURE_OBSERVATION_S = 60` replaces both fixed controller deadlines. This
matches the deploy fixture-observation allowance of sixty seconds. Every
outcome, ownership, overlap and cleanup assertion is unchanged. The same
stressed replay passes all four cases. The test runs in the agents `benchmark`
blackbox domain, which runs on every deploy through agents coverage or Step
4cb. 10k-agent behavior: test-only; no runtime change.

## Human feedback

None recorded.

## Reusable lesson

A fixture that drives real child controllers must bound observations by host
breathing room, not by an unloaded-host duration. Check the evidence for
completed tasks before treating a fixture timeout as an isolation failure.
