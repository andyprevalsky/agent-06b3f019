---
id: 2026-10-01-blackbox-runner-leaked-isolated-backend-and-port-lock
date: 2026-10-01
title: run-blackbox-tests.sh left its isolated backend running and its port lock held after every run
surface: harness
component: blackbox-runner
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/run-blackbox-tests.sh launched the backend through npx and reserved its port in a command substitution
symptoms:
  - node .bin/tsx src/bootstrap.ts reparented to PID 1 after a blackbox run
  - every blackbox run starts its backend one port higher than the last
  - stale directories under .context/test-runs/.port-locks
tags:
  - blackbox
  - process-leak
  - teardown
  - port-lock
sources:
  - PR #1354
repro: scripts/tests/blackbox-backend-teardown.test.sh
status: fixed
---

## Problem

After several backend `agents` blackbox runs during this RCA, each run's
backend was still alive and reparented to PID 1, still serving ports 3101 to
3104, with `BLACKBOX_TEST_RUN_ID` set to runs that had already exited.
`.context/test-runs/.port-locks/` held one directory per finished run, so each
new run reserved the next port up.

## Diagnosis

`BACKEND_PID=$!` was the `npx` process. `npx` does not forward SIGTERM to the
`tsx` process it starts, so `cleanup()` killed only the wrapper. A standalone
repro (`npx tsx -e …`, then kill `$!`) left three survivors out of five
processes, while `node --import tsx -e …` left none. Separately,
`PORT="$(reserve_port …)"` ran `reserve_port` in a subshell, so the
`PORT_LOCK_DIR` it set never reached `cleanup()`, and `rmdir ""` released
nothing. The deepest owned cause is a teardown that tracked a wrapper PID and a
variable set in a subshell, with no test checking that teardown actually freed
anything.

## Solution

- The backend is launched as `node --import tsx src/bootstrap.ts`, the same
  single-process form `run-coverage.sh` uses, so `BACKEND_PID` is the server.
- Cleanup bounds the graceful stop to 10s and then sends SIGKILL.
- `reserve_port` sets `PORT` and `PORT_LOCK_DIR` in the main shell, and the
  trap is installed before the lock is taken.
- `scripts/tests/blackbox-backend-teardown.test.sh` runs the real script with
  an unknown domain, so it exits right after the backend is healthy. It then
  asserts that the run's port no longer answers `/health` and that its lock is
  gone. It fails on the old script and is registered in `scripts/test.sh`. The
  `/deploy` claude-code E2B smoke lane uses the same script, so the fix also
  stops one leaked backend per deploy.

10k agents: not applicable (test harness only).

## Human feedback

None recorded.

## Reusable lesson

Teardown must signal the process that holds the resource, not a wrapper, and
should be proven by a test that checks the resource is free after exit.
