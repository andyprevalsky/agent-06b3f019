---
id: 2026-09-09-status-service-omitted-run-scoped-shutdown-contract
date: 2026-09-09
title: Cloudbench status service omitted the run-scoped shutdown contract used by its production-shaped invocation
surface: infra
component: cloudbench-status-service
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-status-server.py parse_args rejected the run token before the status listener could bind
symptoms:
  - "cloudbench-status-server.py: error: unrecognized arguments: --run-token rca-run-token"
  - production-shaped status service exited before ready with status 2
tags:
  - cloudbench
  - status-service
  - shutdown
  - cli-contract
  - process-lifecycle
sources:
  - commit c6e97b8a98651699bf325e4a290680bf391afe60
  - fleet run 20260909-142400-3810682
repro: scripts/tests/cloudbench-status-service-shutdown.test.sh
status: fixed
---

## Problem

The production-shaped status-service command supplied
`--run-token rca-run-token`, but `argparse` rejected that option and exited 2
before the server created its listener. The same owned-boundary reproduction
failed locally with `unrecognized arguments: --run-token test-run-3823700` and
`FAIL: production-shaped status service exited before ready (status 2)`.

## Diagnosis

The critical path is status-service CLI invocation → argument parsing → socket
bind and ready-file publication → authenticated shutdown request → exact-run
driver signal → cleanup acknowledgement health. The first bad transition was
the argument parser: it had no `--run-token` option, so none of the downstream
lifecycle could run.

The deeper owned cause was contract skew, not a single missing parser option.
The pre-fix service also had no run-token validation, authenticated `/shutdown`
endpoint, PID ownership guard, durable shutdown request, or
`/shutdown-health` acknowledgement boundary. A no-op parser flag would only
move the failure downstream while preserving unsafe or absent shutdown
semantics. No executable status-service lifecycle test was registered in
`scripts/test.sh`, which made that skew possible.

Archive searches for
`unrecognized arguments --run-token cloudbench-status-server` and
`status proxy shutdown process ownership production command` found no matching
case in this branch. Sibling commit `c6e97b8a` contains the broader
Cloud-Fleet-machine-reap RCA, whose first bad boundary is the fleet owner's
teardown ordering. This incident has a distinct first bad boundary in the
status-service CLI and therefore receives a precise case rather than changing
that broader case.

## Solution

The complete status-service contract from sibling owner commit `c6e97b8a` was
ported: `--run-token` is parsed and validated; shutdown control is authenticated;
intent is persisted before signalling; the driver PID must expose the exact
run token in `/proc/<pid>/environ`; and cleanup health returns success only for
an acknowledgement containing the same run token.

The production-shaped executable regression proves CLI readiness, rejects
unauthenticated shutdown, observes request-to-ack state, preserves a process
owned by another run, persists shutdown during the pre-driver race, and rejects
unsafe run tokens. `scripts/test.sh` now discovers it with the other Cloud
benchmark lifecycle tests. The unchanged test passes with
`PASS: status service enforces authenticated run-scoped shutdown and cleanup
acknowledgement`.

The unchanged N=2 fleet canary then passed as run
`20260909-155351-4042019`: both isolated stacks reached the synchronized start
barrier, both infra probes passed, and both exact-owned clones were destroyed.

At 10,000 agents this adds no per-agent polling or shared fan-in. There is one
status service per active guest and work occurs only on run teardown, so cost is
O(active guests) and remains bounded by fleet concurrency.

## Human feedback

The user required ten consecutive 10-task slices with no INFRA result. Any
INFRA result resets the streak and must be diagnosed and fixed before the
sequence restarts; passing benchmark outcomes are not required.

## Reusable lesson

Test lifecycle CLI options through their authenticated state transition instead of treating argument acceptance as the contract.
