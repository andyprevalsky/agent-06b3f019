---
id: 2026-10-07-manifest-lock-waiters-starved-holder-pool
date: 2026-10-07
title: Same-root trace archive manifest lock waiters pinned pool connections and starved the holder's nested queries
surface: back-end
component: archive-manifest-lock
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/traceArchiveManifest.ts withArchiveManifestLock pg_advisory_xact_lock without lock_timeout
symptoms:
  - "Timed out fetching a new connection from the connection pool"
  - backend-coverage-blackbox data-google-sources and data-real-user stalled for about 94 seconds
  - P2024
tags:
  - prisma
  - connection-pool
  - advisory-lock
  - archive-manifest
  - deploy-structural-gates
sources:
  - PR #1417
repro: back-end/src/tests/unit/archive-manifest-lock-pool.test.ts
status: fixed
---

## Problem

During the backend coverage blackbox gate, the `data-google-sources` and
`data-real-user` domains stalled for about 94 seconds and failed with Prisma
pool-acquisition timeouts. Both create agents and delete them shortly after a
chat turn, so archive finalization for one root can overlap another
manifest operation on the same root.

## Diagnosis

`withArchiveManifestLock` opens an interactive transaction and blocks in
`pg_advisory_xact_lock` for the root. That transaction holds one pool
connection for the whole wait. The lock holder's operation then runs nested
queries on the global Prisma client (derived-index writes during
finalization), which need a second connection. With a small pool, same-root
waiters occupy every connection while they block on the advisory lock, so the
holder's nested query cannot obtain a connection and the lock is never
released until Prisma's pool timeout fires. The unit reproduction uses
`connection_limit=2`: one holder and one waiter are enough to fail it on the
old code with "Timed out fetching a new connection from the connection pool".

## Solution

Each lock attempt now sets `lock_timeout` to 2 seconds inside the same
transaction. A `55P03` lock-not-available result becomes a typed busy error,
and `retryWithBackoff` retries it after 100 ms until a 120-second deadline.
Between attempts the waiter's transaction ends and its connection returns to
the pool, so the holder can always run its nested query. The advisory lock
still serializes one root: the reproduction asserts holder-then-waiter order.
Other errors are not retried by this loop.

At 10,000 agents the lock stays keyed per root, so unrelated roots never
contend. A waiter now holds no connection while it waits and issues at most
one short attempt about every 2.1 seconds for one root, instead of pinning a
connection for the full wait.

## Human feedback

None recorded.

## Reusable lesson

A blocking lock wait inside a pooled transaction must be bounded and retried outside the transaction whenever the lock holder needs another connection from the same pool.
