---
id: 2026-11-05-run-process-cleanup-signal-fixture-orphaned-its-service
date: 2026-11-05
title: run-process-cleanup signal fixture orphaned its stand-in `sleep 60`, so the structural gate saw a lingering group
surface: infra
component: deploy-structural-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/run-process-cleanup.test.sh teardown-signal-fixture cleanup() (never stopped its background `sleep 60`)
symptoms:
  - "worker exit and test results disagree"
  - "lingering_group: True"
  - "deploy-command-structural UNVERIFIED with native_exit 0"
  - "orphaned_children: true"
  - "sleep 60 left running after run-deploy-structural-gates.py exited"
tags:
  - deploy
  - structural-gates
  - process-cleanup
  - flaky
sources:
  - PR #1691 (fix/code-agent-multiday-integration), deploy cycle focused attempt on 096709cae
repro: scripts/tests/run-process-cleanup.test.sh (run it under a systemd unit with KillMode=none and count new `sleep 60` processes afterwards)
status: fixed
---

## Problem

During the PR #1691 deploy, the staged cycle's `deploy-command-structural` gate came back UNVERIFIED. The native runner exited 0, but the coordinator recorded `worker exit and test results disagree` with `lingering_group: True`.

The worker's process record (`output.log.process.json`) shows `orphaned_children: true`, and one process was still alive at the end and was sent TERM.

A probe run of `scripts/run-deploy-structural-gates.py --max-workers 5` inside a systemd unit with `KillMode=none` left three orphaned `sleep 60` processes in the unit cgroup after the runner exited 0.

## Diagnosis

`run-process-cleanup.test.sh` builds a teardown-signal fixture that starts `sleep 60 &` as a stand-in service and then `wait`s. On TERM, the fixture's `cleanup()` runs the teardown steps and exits 143, but it never stops that background child. Each of the three signal cases (`single-TERM`, `second-TERM`, ...) therefore orphans one `sleep 60` for up to 60 s.

The orphans only trip the deploy worker's lingering-group check when this suite is among the last to run before the runner exits. That makes the structural gate UNVERIFIED nondeterministically, depending on ordering and load.

Evidence (run alone, leftover `sleep 60` processes counted after exit):
- branch 096709cae: 3 orphans;
- origin/main afdb2fae7: 3 orphans.

The leak predates PR #1691 (NOT_INTRODUCED).

## Solution

The fixture records `SERVICE_PID=$!` for its stand-in service, and `cleanup()` kills it before writing `done`, the same way `run.sh` stops its services. The assertions are unchanged.

After the fix, the suite passed 5 of 5 runs with 0 new `sleep 60` processes per run. This is a test-only change with no runtime or 10k-agent impact.

## Human feedback

None recorded.

## Reusable lesson

A test fixture that starts background stand-in processes must stop them in its own cleanup; the deploy worker treats any survivor as a lingering group and refuses to verify the gate.
