---
id: 2026-11-06-github-token-test-trap-killed-mock-server-without-reaping
date: 2026-11-06
title: cloudbench-github-token test's EXIT trap TERMed its mock GitHub server without waiting, so under load the controller-gate supervisor reaped an orphan and marked the step UNVERIFIED
surface: infra
component: cloudbench-controller-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-github-token.test.sh EXIT trap: `kill \"$SERVER_PID\"` with no `wait`"
symptoms:
  - "GATE_STEP github-token status=UNVERIFIED exit=0"
  - "\"orphaned_children\": true"
  - "cloudbench-controller: FAIL {'cloudbench-controller': 'UNVERIFIED'}"
tags:
  - deploy
  - cloudbench-controller
  - flaky
  - load
  - teardown
sources:
  - PR #1730 staged deploy, attempt 2, cloudbench-controller gate (2026-11-06 10:23Z), run-cloudbench-controller-local.py run-7wr6yey3
repro: scripts/tests/cloudbench-github-token.test.sh under scripts/cloudbench-local-supervisor.py in a CPUQuota=15% scope
status: fixed
---

## Problem

During the PR #1730 deploy, the `cloudbench-controller` gate returned UNVERIFIED.
Every Step 4cb suite passed except `github-token`. That test printed `ALL CHECKS
PASSED` and exited 0, but `cloudbench-local-supervisor.py` recorded
`orphaned_children: true`: it had to TERM pid 3981415 (reaped with status 15)
after the test's own shell had exited. The gate counts that as unverified
cleanup. The same suite passed in the PR #1724 final cycle.

## Diagnosis

The test starts its mock GitHub API as a background `python3 - &`. Its EXIT trap
runs `rm -rf "$TMP"; kill "$SERVER_PID"` and returns without waiting. On an idle
host the server dies before the supervisor's quiescence check. Under the deploy's
concurrent gate load, the shell can exit while the TERMed server is still
scheduled to run. The supervisor then finds a live descendant, reaps it itself
and reports an orphan.

Repro on bytes identical to origin/main (the test, its library and the
supervisor are unchanged by #1730): 8 supervised runs in a `CPUQuota=15%`
scope. 1 of 8 left an orphan the supervisor TERMed (`term_sent [766689]`). Gate:
NOT_INTRODUCED, since #1730 does not touch these files.

## Solution

The trap kills the server and then `wait`s for it before removing the fixture
directory, so the test never exits with a live child. It also tolerates an
unset `SERVER_PID` under `set -u`. Under the same throttled supervisor, 0 of 16
runs left an orphan. The supervisor's existing orphan check in the
cloudbench-controller deploy gate is the regression: it fails this step
whenever the test leaves a child behind.

10k-agent behavior: none (test fixture only).

## Human feedback

None recorded.

## Reusable lesson

A test that starts a background helper must reap it (`kill` then `wait`) in its
EXIT trap. A supervised gate treats any child that outlives the test as a
cleanup failure.
