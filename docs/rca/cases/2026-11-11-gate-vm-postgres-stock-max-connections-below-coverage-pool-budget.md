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
  - "Invalid `tx.message.create()` invocation in back-end/src/providers/toolLifecycleMessages.ts:390:36 Foreign key constraint violated: `Message_agentId_fkey (index)`"
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
  - PR #2221 (merge 55655e654472)
  - PR #1946 deploy round 6 backend-coverage-blackbox/units (source 223f387721080950d4d56a86eb914aadcabeb410, merged as d39e7e64092ddc90273b2b376c4b294516acc79c)
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

### 2026-11-15 occurrence on a branch without the fix (PR #1946 round 6)

PR #1946's sixth deploy round failed `backend-coverage-blackbox/units` in one
file, `workflow-restart-tools.test.ts`, case "concurrent success and deploy
reconciliation produce exactly one terminal result". The runner reported "Too
many database connections opened: FATAL: sorry, too many clients already".
Rounds 1–5 had passed. Five `Message_agentId_fkey` violations at
`toolLifecycleMessages.ts:390` printed beside the failure.

- **The fix did not regress.** The failed source `223f3877` (11-11 23:40) does
  not contain `917e6bc6f1`. The branch had not merged main since #1955/#1956.
  `deploy-gates.yml` runs `scripts/ci/deploy-gate-setup.sh` from the request
  commit, so that VM kept the stock cap of 100. The merge `d39e7e64` and current
  main both contain the fix.
- **The FK errors are teardown fallout.** The case's first step is 24 concurrent
  `IN_PROGRESS` writes. Every committed row in the log is the 48-character
  `IN_PROGRESS:<uuid>`, and there is no `Reconciled stale workflow tool calls`
  line, so reconciliation never ran. One refused connect rejected `Promise.all`.
  `withAgent`'s `finally` then deleted the Agent at 23:46:00.178. The sibling
  inserts still in flight hit the missing parent 6–7 ms later.
- **Local repro on devbox 413b5b6a.** The harness from
  `docs/handoffs/pr-1955-closeout/repro/` ran against a private PG16 cluster
  restored from the local schema. Each run used the real `run-unit-tests.ts` at
  gate parameters (concurrency 6, `connection_limit=16`).
  - No load, cap 100: PASS, peak 17 clients.
  - 90 held sessions, cap 100: the same case FAILS with the same FATAL. The
    runner surfaced it through teardown `prisma.agent.deleteMany` at
    `workflow-restart-tools.test.ts:85`.
  - Same load, cap 300: PASS, then 5 further consecutive PASSes with unchanged
    test code (peaks 107–197, zero "too many clients").
  - An independent reviewer reached the same first bad boundary. It found no
    product path to two terminal rows: per-call advisory locks under the
    generation lock, and deploy-fenced late writes.
- No test, assertion, timeout, pool, concurrency or product change. The test
  carried no quarantine marker, so there is nothing to release.
- Shipped as RCA-only PR #2221 (merge 55655e6544). On its frozen HEAD the
  original failing command, Blacksmith `backend-coverage-blackbox` run
  43690209043, passed 272/272. That includes `units` (459/459, with
  `workflow-restart-tools.test.ts`) and `coverage-threshold`. Evidence is in
  `docs/handoffs/pr-2221-closeout/`.

## Human feedback

None recorded.

## Reusable lesson

When a test DB error is "too many clients" on one runner type only, compare that
runner's live `SHOW max_connections` with the pool budget the test scripts assume
before touching the tests.
