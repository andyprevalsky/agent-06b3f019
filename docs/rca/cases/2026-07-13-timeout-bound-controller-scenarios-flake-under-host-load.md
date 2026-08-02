---
id: 2026-07-13-timeout-bound-controller-scenarios-flake-under-host-load
date: 2026-07-13
title: Timeout-bound controller scenarios in the cloudbench regression flaked under host load from ~20 sibling workspaces
surface: harness
component: cloudbench-fleet
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/tests/cloudbench-multi-workstream.test.sh — 240s-timeout controller scenarios run on a Mac shared with ~20 other Conductor workspace workers
symptoms:
  - controller scenario exits 143 (SIGTERM) mid-run
  - barrier timeout at a random scenario (3, 10) — different one each run
  - never a logic assertion failure, always a kill or timeout
tags:
  - cloudbench-fleet
  - flaky-test
  - host-load
  - deploy-gate
  - sigterm
sources:
  - memory:project_cloud_smoke_infra_blockers_jul2026
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: mitigated
---

## Problem

`scripts/run-predeploy-cloud` runs `cloudbench-multi-workstream.test.sh`
(14 scenarios, many of them controllers with 240s timeouts) locally _before_
dispatch. During the 2026-07-13 deploy these scenarios failed repeatedly — but a
_different_ scenario each run (observed at 3 and 10), and always with either
`exit 143` (SIGTERM) or a barrier timeout. Never once with a logic assertion.

## Diagnosis

Machine load at the time was 12–16, driven by roughly 20 other Conductor
workspace workers on the same Mac. Under that load the timeout-bound controllers
in the scenario suite could not make progress inside their 240s budgets and were
either killed or hit their barrier deadlines.

The signature is diagnostic and worth memorizing: **random victim scenario +
always a timeout/kill and never an assertion = host load, not a defect in the
code under test.** The suite passed reliably once load dropped below about 8.

The owned weakness is the suite's design: wall-clock-bound controller scenarios
have no admission control for host load, so the deploy gate's pass/fail depends
on what other workspaces happen to be doing.

## Solution

Treat this class of failure as load flake and re-run once host load drops below
~8, rather than chasing the scenario that happened to lose. For validating
`run-bench-fleet` edits deterministically — with no timing dependence at all —
use `agents/benchmarks/cloudbench_dependency_sync_test.py` (35 tests: pool ledger,
clone identity, recovery lock) and `scripts/tests/cloudbench-env.test.sh` instead
of the timing-sensitive cloud path.

## Human feedback

None recorded.

## Reusable lesson

A different scenario failing each run, always by timeout or SIGTERM and never by
assertion, is host-load flake — check load average before debugging the code.
