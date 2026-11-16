---
id: 2026-11-16-read-only-tx-5s-body-timeout-failed-ownership-assert
date: 2026-11-16
title: runReadOnlyTransactionWithRetry's 5 s body timeout (#2285) failed every attempt of a healthy cutover ownership assert during a slow-DB window
surface: back-end
component: prisma-transactions
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/database.ts runReadOnlyTransactionWithRetry — `{ maxWait: 3_000, timeout: 5_000 }` halved the 10 s body budget assertWorkerDeploymentOwned had under runTransactionWithRetry
symptoms:
  - "Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms"
  - "PrismaReadOnlyTx: attempt 4/5 failed"
  - "Deployment queue assert-mutable exited 1; its stderr follows"
  - "P2028"
tags:
  - prisma
  - fly-cutover
  - timeout
  - regression
sources:
  - PR #2285 (merge 8980306b3e) introduced the 5 s timeout
  - commit 85f05ea3f9 (descendant deploy-agents run 43822304711 recovered job dafd2e after run 43822297504 failed)
repro: back-end/src/tests/unit/database-transaction-retry.test.ts "read-only transaction keeps a 10 s body budget" (BACKEND_UNIT_TEST_FILES=database-transaction-retry.test.ts npm run test:unit)
status: fixed
---

## Problem

deploy-agents run 43822297504 (merge 8980306b3e) died in "Cooperative Fly deploy +
generation cutover": `assert-mutable` -> `assertWorkerDeploymentOwned` failed 5 of 5
attempts (07:18:58–07:19:23Z), each with P2028 "Transaction already closed ... timeout
for this transaction was 5000 ms, however 5082 ms passed" at
workerDeploymentQueue.ts:143 `tx.toolSideEffect.findFirst`. Prisma query durations in
that run: n=481, p50 120 ms, max 5987 ms. Ownership held: descendant run 43822304711
recovered job dafd2e with 0 read-only retries.

## Diagnosis

- What: a healthy, read-only ownership check timed out on every attempt.
- Where: `runReadOnlyTransactionWithRetry` in back-end/src/providers/database.ts passed
  `{ maxWait: 3_000, timeout: 5_000 }` and 5 attempts.
- Why: #2285 (case 2026-11-16-cutover-ownership-assert-died-on-db-error-stderr-discarded)
  moved the assert from `runTransactionWithRetry` (default 10 s body) to the new helper
  and shrank the body budget to 5 s so that 5 attempts fit the 60 s controller timeout.
  A slow-DB window pushed individual queries past 5 s (max 5987 ms), so every replay hit
  the same P2028; retrying a timeout with the same too-small budget cannot help.
- Proof: the regression test runs a read-only transaction whose body does
  `SELECT pg_sleep(6)`. On origin/main it fails all 5 attempts with the exact prod text
  ("timeout for this transaction was 5000 ms, however 6009 ms passed"), exit 1 in 36 s;
  after the fix it passes on attempt 1 in about 7.5 s, 5 of 5 runs.
- Why was this possible: the #2285 retry budget was sized by attempt count, trading the
  per-attempt budget for more attempts, and no test pinned the body budget the check had
  before.

## Solution

`runReadOnlyTransactionWithRetry` restores the 10 s body timeout and 5 s maxWait and
defaults to 3 attempts: 3 x (5 s + 10 s) + 0.25 + 0.5 s backoff is about 46 s, inside the
60 s controller timeout. `SET TRANSACTION READ ONLY` and the Prisma-error-only retry
classifier are unchanged, so the #2285 transient-connection case still retries. The
regression test also asserts the transaction stays `transaction_read_only = on`.
Not covered (follow-up): `assert-mutable` runs this assert and then a second
`runTransactionWithRetry` (workerDeploymentMachineAdmission.ts) under the same 60 s
subprocess timeout, so its theoretical worst case (all attempts hitting full wait and
body) can still exceed 60 s; this was also true of the #2285 budget. Independent review
could not tell from the summary whether the 5987 ms was a slow query or an advisory-lock
wait. The interactive-transaction allowlist fingerprint for the helper was updated.
10k behavior: unchanged; one controller per Fly app, at most two extra short read-only
transactions per failed check.

## Human feedback

The user specified the fix (restore 10 s/5 s, maxRetries 3, keep READ ONLY and the
classifier) and the DB-backed regression shape (pg_sleep(6) must pass on attempt 1).

## Reusable lesson

When adding retries under a fixed outer deadline, shrink the attempt count, never the
per-attempt timeout below what the operation had before; a timeout replayed with the
same budget fails the same way.
