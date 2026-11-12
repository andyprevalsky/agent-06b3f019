---
id: 2026-11-11-gate-vm-postgres-stock-max-connections-below-coverage-pool-budget
date: 2026-11-11
title: Blacksmith deploy gate Postgres kept stock max_connections=100 below the backend coverage pool budget
surface: infra
component: deploy-gate-setup
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/ci/deploy-gate-setup.sh postgres step (started the runner image's server without the devbox max_connections)
symptoms:
  - "Too many database connections opened: FATAL: sorry, too many clients already"
  - "PrismaClientInitializationError: Invalid `prisma.toolSideEffect.findUnique()` invocation in back-end/src/providers/workerDeploymentQueue.ts:135"
  - "concurrent success and deploy reconciliation produce exactly one terminal result: Too many database connections opened"
  - backend-coverage-blackbox/units FAIL worker-deployment-queue.test.ts workflow-restart-tools.test.ts
tags:
  - deploy-gates
  - blacksmith
  - postgres
  - max-connections
  - backend-coverage
  - runner-parity
sources:
  - PR #1947 round 1 backend-coverage-blackbox (head fd8b1a1486fbebb5ad2a7de13a2777434b2ffd94, Actions run 43083582799)
  - PR #1932 FLAKY ae9ae00c (Lantern small pool) and PR #1885 auth-options baseline run 42694223937 (cap 100, sampled peak 79)
  - commit f76adfe108 (fix/gate-vm-postgres-max-connections)
repro: scripts/tests/deploy-test-github.test.py (GateSetupPostgres)
status: fixed
---

## Problem

PR #1947's first backend-coverage-blackbox round on Blacksmith failed the unit
pass in `worker-deployment-queue.test.ts` (`readWorkerDeployment`,
`workerDeploymentQueue.ts:135`: "Too many database connections opened: FATAL:
sorry, too many clients already") and `workflow-restart-tools.test.ts`. The PR
changed one iPhone predicate and no import reached either file; a full rerun
passed. The same refusal hit the Lantern small-pool blackbox (PR #1932) and
auth-options (PR #1885) on other deploys that day.

The `P0001 "fixture publication rejected"` stack printed near these failures is
not a second defect: `worker-route-retention.cases.ts` installs that trigger and
asserts the rejection, and Prisma's error logger prints it in passing runs too
(verified in a passing local `worker-deployment-queue` log).

## Diagnosis

1. The gate's backend sweep (`run-coverage-sharded.sh 2`) runs two coverage
   shards and the unit pass at the same time against one system Postgres. Each
   process has its own Prisma pool (`connection_limit=16`), and
   `run-coverage.sh` sizes that budget for "system max_connections is 300".
2. Devboxes get 300 from `scripts/cloud-build.sh`. `scripts/ci/deploy-gate-setup.sh`
   only started the runner image's server, which keeps Ubuntu's stock 100. A
   baseline gate run on main measured cap 100 with a sampled peak of 79.
3. The unit pass alone peaks at about 24 server clients (measured locally at the
   gate parameters: concurrency 6, pool 16). The overflow happens when its
   connects land while the shards' pools are near full, so failures move between
   files and rounds.
4. Local reproduction used the real `run-unit-tests.ts` against a private PG16
   cluster, with idle sessions standing in for the shard pools:
   - At cap 100, holding 85, 90 or 92 sessions made `workflow-restart-tools`
     fail with the exact error.
   - At cap 100, a surge 5 s into `worker-deployment-queue` failed it at
     `workerDeploymentQueue.ts:135`.
   - At cap 300, the same loads passed both files, including a surge peaking at
     106 clients.

## Solution

`deploy-gate-setup.sh` now writes `max_connections = 300` (devbox parity),
restarts Postgres, and fails setup unless the live server reports 300. The
`GateSetupPostgres` regression in the deploy-structural `deploy-test-github`
suite runs the real step with stand-in sudo/systemctl/psql. It fails on the old
script and checks parity with `cloud-build.sh`. Test concurrency, pool sizes,
assertions and timeouts are unchanged. It is CI-runner configuration only, so
the agent count does not affect it.

## Human feedback

None recorded.

## Reusable lesson

When a test DB error is "too many clients" on one runner type only, compare that
runner's live `SHOW max_connections` with the pool budget the test scripts assume
before touching the tests.
