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
  - pg_advisory_xact_lock( hashtextextended($1, $2) ) 165,841 calls, 4.1 s average, 120 s worst (prod pg_stat_statements 2026-10-26)
  - manifest lock held a pooled connection in an open transaction during storage I/O
tags:
  - prisma
  - connection-pool
  - advisory-lock
  - archive-manifest
  - deploy-structural-gates
sources:
  - PR #1417
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/blackbox/archive-run-cost.helper.ts (manifest lock holds no connection during storage I/O); back-end/src/tests/unit/archive-manifest-lock-pool.test.ts
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

### Recurrence 2026-10-26 (100-seat audit lane S10): the holder still pinned a connection

The 2026-10-07 fix bounded the *waiters* but kept the *holder* inside an
interactive transaction for its whole operation, including R2 reads and
writes. Prod `pg_stat_statements` (read-only, 2026-10-26) showed the lock
statement at 165,841 calls, 4.1 s average and 120 s worst. Each holder pinned
one of Supavisor's 60 server connections for as long as its storage I/O ran.
The per-process admission limit added on 2026-10-07 only rationed that
pinning; it did not remove it.

Why the earlier fix did not hold: it treated the symptom (waiters filling the
pool) at the waiter, while the first-bad boundary is the lock *primitive*. A
transaction-scoped advisory lock ties lock lifetime to a pooled connection.

Repro: `ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=s10lane
CONDUCTOR_PORT=4710 bash back-end/scripts/run-blackbox-tests.sh archive`, case
`manifest lock holds no connection during storage I/O`. Before the fix it
failed with `manifest lock held a pooled connection in an open transaction
during storage I/O: [{"pid":2841884,...}]`; it passes now.

Fix: `TraceArchiveManifestLease`, one row per root (owner, expiry). Each step
is a single autocommit statement, so no connection or transaction stays open
across the operation:
- acquire: a conditional upsert that takes the row only when it has expired;
- check ownership: a `SELECT` before each write;
- release: an owner-scoped `DELETE`.
The expiry is fixed at acquire + 120 s, the same bound the old transaction
timeout gave, so a crashed holder's lease simply lapses. The admission limiter
is removed.

Tests adapted to the new mechanism, keeping their assertions:
- the native lease-loss cases now expire the root's lease row instead of
  terminating the advisory-lock backend;
- waiter observation uses `archiveManifestLockWaiters()`;
- the pool test now asserts per-root serialization, and that distinct roots can
  hold leases beyond the pool size.

At 10,000 agents: lease rows are bounded by roots currently being written, plus
expired leftovers from crashed holders, which the next acquire overwrites. Each
held lease costs zero connections. Waiters back off exponentially, from 100 ms
up to 1 s, within the same 120 s deadline.

Review follow-ups (deploy takeover, 2026-10-26):
- Acquire is idempotent for the same owner. A P1017 retry after a committed
  insert re-takes its own lease instead of waiting 120 s behind itself.
- Lease renewal and storage-write fencing were not added. The old lock had the
  same fixed 120 s bound and the same check-then-write window, so this keeps
  parity. Fencing R2 overwrites would need a lease generation carried into
  every storage write; that is tracked as a follow-up.

## Human feedback

None recorded.

## Reusable lesson

Never hold a pooled transaction across external I/O for mutual exclusion; use a lease row (owner + expiry, single-statement acquire, check and release) so neither holders nor waiters pin connections.
