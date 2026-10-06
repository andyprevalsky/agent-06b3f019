---
id: 2026-10-02-workspace-env-fake-store-daemon-published-before-exec
date: 2026-10-02
title: workspace-env.test.sh published its fake store daemon's pid before the daemon exec'd, so a loaded host read the forked test shell's cmdline
surface: infra
component: workspace-env-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/workspace-env.test.sh — the fake store daemon case wrote `pid=$!` to `ready` immediately after `&`, before the child had exec'd into `cursor-agent-store-fuse`
symptoms:
  - "FAIL: a running store daemon's id is the agent id: got '', expected 'bc-live'"
  - "failed deploy structural gates: workspace-env"
tags:
  - flaky-test
  - procfs
  - fork-exec
  - deploy-gate
  - cloud-identity
sources:
  - PR #1341
repro: run the fake store daemon case from scripts/tests/workspace-env.test.sh 6000 times with xargs -P 300 beside 16 CPU busy loops (4 failures unfixed, 0 fixed)
status: fixed
---

## Problem

`/deploy` Step 3 (`deploy-command-structural`, deploy run
`20261002-191915-1586598`, HEAD `3a4ac75c5`) failed the `workspace-env` gate
with `a running store daemon's id is the agent id: got '', expected 'bc-live'`.
The case arrived from `main` in `e4739d1f0` ("key the synthetic cloud workspace
id to the running instance"). It ran while the structural gates and the backend,
frontend, and agents coverage lanes shared a 4-CPU host. The same test passed
3/3 standalone.

## Diagnosis

### Evidence

The case was extracted unchanged into a loop and run with 300-way parallelism
next to 16 busy-loop CPU hogs:

- 6000 runs unfixed: 4 failures. When the pid was published, the fake daemon's
  `/proc/<pid>/cmdline` read as:
  - `bash /tmp/store-race.sh` (the forked parent shell) twice;
  - `bash -c exec -a cursor-agent-store-fuse sleep 60` once, after which the
    helper's later read landed mid-exec;
  - empty once (mid-exec).
- 6000 runs with the readiness wait below: 0 failures.

### Root cause

`cloud_env_agent_id` trusts the store id only while the pid in `ready` belongs
to a process whose cmdline contains `agent-store-fuse`. This production contract
is correct, because the real daemon writes `ready` itself once it is running.

The test did not follow that order. It wrote `pid=$!` straight after
`bash -c 'exec -a cursor-agent-store-fuse sleep 60' &`. Until both execs finish,
`/proc/<pid>/cmdline` shows either the forked test shell's own command line or
nothing (while the process is mid-exec). On a loaded host the child can stay
unscheduled long enough for the helper to read that cmdline and correctly reject
it.

## Solution

The test now waits, bounded at 5s, until the fake daemon's cmdline starts with
`cursor-agent-store-fuse` before writing `ready`. That is the same order a real
daemon guarantees. The production helper is unchanged, so its stale-id and
reused-pid rejections are still exercised by the two cases that follow.

## Human feedback

None recorded.

## Reusable lesson

A test that stands in for a daemon must publish the daemon's readiness only
after the stand-in really is that daemon. A pid taken straight from `$!` names a
fork that has not exec'd yet, and anything that inspects `/proc` will see the
parent until it does.
