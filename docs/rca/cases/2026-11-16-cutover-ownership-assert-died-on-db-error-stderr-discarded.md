---
id: 2026-11-16-cutover-ownership-assert-died-on-db-error-stderr-discarded
date: 2026-11-16
title: Fly cutover drain-loop ownership assert exited 1 on a database error while ownership held; the controller discarded its stderr
surface: infra
component: worker-deployment-queue
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/workerDeploymentQueue.ts assertWorkerDeploymentOwned — runTransactionWithRetry never replays a database error raised after the transaction body starts, and scripts/worker_pool_cutover.py Ledger.call dropped the child's captured stderr
symptoms:
  - "worker-deployment-queue.ts', 'assert', '--job-id'"
  - "returned non-zero exit status 1"
  - "Error: Owned deployment child exited 1"
  - "Cooperative Fly deploy + generation cutover"
tags:
  - fly-cutover
  - prisma
  - observability
sources:
  - commit 26714e91d0 (deploy-agents run 43785616839, job 729cd67a)
  - commit fd46466be0
repro: back-end/src/tests/unit/worker-deployment-transient.cases.ts (run via BACKEND_UNIT_TEST_FILES=worker-deployment-queue.test.ts npm run test:unit); scripts/tests/worker-pool-cutover.test.py test_failed_queue_command_forwards_its_stderr_reason
status: mitigated
---

## Problem

deploy-agents run 43785616839 (source 26714e91d0, 2026-11-16 01:30:41Z) failed in
"Cooperative Fly deploy + generation cutover": `worker_pool_cutover.py run()` drain loop
-> `ledger.assert_owned()` -> `worker-deployment-queue.ts assert --job-id 729cd67a...`
"returned non-zero exit status 1". `Ledger.call` ran the child with `capture_output=True,
check=True`, so its stderr (the only place the CLI reports why) never reached the log.
The job was recovered later by another owner and reached SUCCEEDED at 01:44.

## Diagnosis

Ownership held at the failure, so the assert died on the database (by elimination, since
the stderr is lost):

- Lease: the parent queue process renewed every second (`ToolSideEffect updateMany ok`
  through 01:30:42.85) and printed "Owned deployment child exited 1", not "Deployment lease
  lost". Its failure write (`recordWorkerDeploymentFailure` -> `mutation()`) re-ran the
  same lease, job-decode and FIFO-head checks with the same owner 330 ms later, all ok.
- FIFO and terminal state: prod DB rows show 729cd67a was the only non-terminal job for
  navi-whisper-lux (8f17dee4 SUCCEEDED 2026-11-15 21:46), and it later SUCCEEDED.
- Timeout: a Python timeout raises TimeoutExpired, not CalledProcessError. The parent's
  lock-wait timings show the failing child never held the lease lock.

The remaining cause is a Prisma or database error inside the assert's one transaction.
`runTransactionWithRetry` replays only P1001/P1017/P2024 or "Unable to start a
transaction", and only before the body starts. That rule is right for writes, but it
made a read-only check fatal. There is one occurrence in the deploy-agents failure
history; the other recent failures are Fly HTTP errors.

The local repro: hold the lease advisory lock, park `assertWorkerDeploymentOwned` behind
it, and `pg_terminate_backend` its connection. On the old code it rejects with P2010 /
57P01 "terminating connection due to administrator command".

## Solution

- `assertWorkerDeploymentOwned` runs in the new `runReadOnlyTransactionWithRetry`
  (back-end/src/providers/database.ts). The transaction starts with `SET TRANSACTION READ
  ONLY`, so Postgres guarantees a replay cannot duplicate a write. It retries Prisma
  database error classes (bounded: 5 attempts, about 44 s worst case, inside the 60 s
  controller timeout). Plain `Error`s, such as a lost lease or FIFO change, stay fatal.
- `Ledger.call` forwards the child's stderr on a non-zero exit or a timeout, so the next
  failure names its reason.
- 10k behavior: unchanged. It runs one controller per Fly app, and a retry adds at most
  four extra short read-only transactions per failed check.
- Not covered (follow-ups): the parent's 1 s lease renewal
  (workflowDeploymentLease.ts) still treats one transient renewal error as permanent lease
  loss. The other read-only ledger actions (`read`, `head`, `retained-status`) still use
  `runTransactionWithRetry` or plain reads.

## Human feedback

None recorded.

## Reusable lesson

A controller that shells out must log the child's stderr on failure. A read-only check
should run in a Postgres READ ONLY transaction so a mid-body database error can be safely
replayed instead of aborting a healthy cutover.
