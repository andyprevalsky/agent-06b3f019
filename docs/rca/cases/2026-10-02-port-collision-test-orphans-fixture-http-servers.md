---
id: 2026-10-02-port-collision-test-orphans-fixture-http-servers
date: 2026-10-02
title: run-port-collision structural gate orphaned three python http.server listeners to PID 1 on every run
surface: infra
component: deploy-structural-gates
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/run-port-collision.test.sh — fixture listeners launched as `( cd dir; python3 -m http.server ... ) &`, so PIDS held the wrapping subshell and cleanup killed it while the forked server kept listening
symptoms:
  - 'python3 -m http.server 61000 --bind 127.0.0.1'
  - 'FAIL: fixture listener on port 61024 outlived the test cleanup'
tags:
  - deploy
  - structural-gates
  - process-leak
  - run-sh
sources:
  - PR #1354
repro: 'bash scripts/tests/run-port-collision.test.sh, then ps -eo pid,ppid,cmd | grep "http.server 610": three new listeners with PPID 1 per run (evidence in /opt/cursor/artifacts/port-collision-leak-before.log and -after.log)'
status: fixed
---

## Problem

After several `/deploy` runs for PR #1354 the Cloud VM held 21 orphaned
`python3 -m http.server` processes on ports 61000-61020, three per run, each with
PPID 1. They kept host ports in the 61000-61999 range that the gate scans busy and
accumulated across every deploy on the machine.

## Diagnosis

- Running `scripts/tests/run-port-collision.test.sh` alone left exactly three new
  listeners (61021-61023) after it exited 0.
- The three leaked fixtures are the ones wrapped in a subshell that runs `cd`
  first. `$!` is the subshell PID, and bash forks the server rather than exec'ing
  it, so `kill` plus `wait` in `cleanup` reaped the subshell and orphaned the
  server. The direct `python3 ... &` fixture was reaped correctly.
- `scripts/run.sh` returns before installing its traps when
  `RUN_SH_SOURCE_ONLY=true`, so the test's EXIT trap was not being replaced.
- `scripts/tests/kill-services.test.sh` already records the real listener PID via
  `lsof`, so it does not leak.

## Solution

Each subshell now `exec`s its server so the tracked PID is the listener, and the
test fails if any fixture port is still listening after its PIDs are stopped.
This deploy reproduced and fixed it independently (a copy without `exec` failed
with `fixture listener on port 61024 outlived the test cleanup`; the fixed test
passed and left no listener). Main had already landed the same fix in
`f0ef0ea58`, so the merged test is main's version. The gate runs in `/deploy` via
`scripts/run-deploy-structural-gates.py`.

## Human feedback

None recorded. Found while running the user-requested `/deploy` for PR #1354.

## Reusable lesson

A background fixture's tracked PID must be the process that owns the resource.
Wrap with `exec` (or look the owner up by port) and assert the resource is
released, not just that the wrapper exited.
