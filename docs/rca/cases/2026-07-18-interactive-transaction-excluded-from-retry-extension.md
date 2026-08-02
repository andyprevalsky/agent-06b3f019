---
id: 2026-07-18-interactive-transaction-excluded-from-retry-extension
date: 2026-07-18
title: Prisma's $allOperations retry extension never wrapped $transaction(fn), so a P2028 transaction-start timeout 500'd agent creation with no retry
surface: back-end
component: prisma-transactions
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/database.ts — the $allOperations retry extension wraps individual queries only, leaving interactive $transaction(fn) unretried
symptoms:
  - "P2028 Unable to start a transaction in the given time"
  - "POST /api/agents -> 500" intermittently while /health is green
  - chat-lifecycle-ratchet prod semantic gate flakes when many agents start at once
tags:
  - prisma
  - p2028
  - transaction-retry
  - connection-pool
  - flaky-gate
sources:
  - PR #785
repro: back-end unit suite `database-transaction-retry`
status: fixed
---

## Problem

`POST /api/agents` intermittently returned 500 in production with Prisma
`P2028 "Unable to start a transaction in the given time"`, while the database was
demonstrably healthy — `/health` green, 13/13 endpoint smoke green, broadcasts
firing. The same flake intermittently failed the `chat-lifecycle-ratchet` prod
semantic gate, which spins up many agents simultaneously. Reproduced against
prod.

## Diagnosis

`createAgentTransaction` uses an interactive `prisma.$transaction(fn)`. The
client's retry extension is registered on `$allOperations`, which intercepts
_individual queries_ — it does not wrap `$transaction(fn)`. So under momentary
connection-pool pressure the transaction failed to **start** (P2028) and the error
propagated straight to a 500 with no retry at all, even though the failure is
transient and, crucially, side-effect-free: nothing had executed yet. The deepest
owned cause is a coverage gap in where resilience was attached — the retry policy
looked global but silently excluded the one call shape used for the hottest write
path.

## Solution

Added `runTransactionWithRetry` in `back-end/src/providers/database.ts`, which
delegates to the canonical `retryWithBackoff` with a transaction-start-only
predicate (`isRetryableTransactionError`: P2024/P2028 plus the canonical message)
and a larger `maxWait` (5s) for headroom. Only the side-effect-free start timeout
is retried, never a partially executed transaction. Wired into both
`createAgentTransaction` and `createAgentBatchTransaction`. Defense in depth: the
semantic `createAgent` helper now retries the same transient 500 that the blackbox
helpers already retried. Covered by 8/8 new `database-transaction-retry` unit
tests; no hand-rolled retry loop and no lint disables.

## Human feedback

None recorded.

## Reusable lesson

Verify what a client-level retry extension actually intercepts — `$allOperations`
does not cover interactive `$transaction(fn)`, so retry the start timeout
explicitly and only for the side-effect-free start failure.
