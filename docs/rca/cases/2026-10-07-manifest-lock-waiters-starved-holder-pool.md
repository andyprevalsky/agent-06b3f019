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

### Recurrence 2026-10-27: the connection probe did not attribute transactions to its subject

The same `manifest lock held a pooled connection in an open transaction during storage I/O` assertion failed again on source `8b1c38ff451f00d1cacb1c4f5fa8c05acc448e2c`, after the lease-row change. The archived native backend gate passed 226 domains and failed 2; the archive domain took 24,700 ms. Its connection case reported PIDs 707565 and 707628 with transaction starts 01:19:05.100Z and 01:19:06.336Z. **Those historical rows do not identify the client, process, application, or owning operation. Their ownership remains unproved. This recurrence does not establish that the lease implementation held either transaction.** The separate browser-session failure belongs to another RCA lane.

The newly reproduced first-bad boundary is the test observer in `archive-run-cost.helper.ts`. Its query selected every other idle transaction in the current database with `xact_start <= operationStart`. Intersecting two samples by PID and transaction start proves persistence, but does not attribute either transaction to the manifest test. The earlier regression assumed database-wide exclusivity while the native full-suite runner shares one fixture database across parallel domain processes.

Causal native proof used a separate local database, `victoria_archive_rca_20261027`, and an owned local backend. The unchanged `bash back-end/scripts/run-blackbox-tests.sh archive` passed all 13 cases without foreign transactions. Holding two identified foreign Prisma transactions made that same suite fail 12/13 and report exactly the injected PIDs 1205062 and 1205077. The assertion took 1,248 ms; the archive domain took 3,530 ms. Both transactions were released and both clients joined after the run.

The applied correction stamps every native test-child connection with a unique PostgreSQL `application_name` when the pool is created. The probe verifies its live PostgreSQL owner identity, observes that owner's transactions, and includes owner identity in failure output. Stamping at pool creation includes transactions older than the storage callback; it does not hide old transactions by comparing to a newly captured PID list. The two original 600 ms waits and the zero-pinned-owned-transactions assertion remain unchanged. No production manifest code, polling deadline, concurrency setting, or expected result is changed.

The corrected native case includes an old-owned-transaction positive control and a foreign-transaction negative control. The foreign connection is verified idle before and after storage observation, then rolled back and disconnected. With only the owner predicate removed, the stronger native suite failed 12/13, reporting all three actual foreign owners. With the predicate restored, the final exact proposal passed 13/13: archive 3,747 ms, owning case 1,328 ms, whole command 14.649 seconds including setup. An additional direct invocation of the same exported native probe failed on old owned PID 1216666 and passed after its rollback. Touched-file ESLint passed.

Scratch proposal SHA256: `8f5c4602cb22b1be1e0dd8843b8bc0b8c34f3cb391d578c3de210b6d45d49134`. Full commands, before/after output, ownership receipts, source hashes, and exact patch are retained in `.context/archive-connection-rca-20261027/`. The local fixture database was dropped after checking zero other sessions, port 47350 was verified closed, and owned control/backend processes were joined. Freedom and unrelated source changes were preserved.

The exact reviewed patch was applied to the shared source with both file hashes matching the native-tested snapshot. The complete combined-source backend gate remains pending; this is not deployment proof. The coordinator owns archive/index updates and full acceptance. Retain the historical-PID ownership gap even if the corrected combined gate passes.

## Human feedback

None recorded.

## Reusable lesson

Never hold a pooled transaction across external I/O for mutual exclusion; use a lease row (owner + expiry, single-statement acquire, check and release) so neither holders nor waiters pin connections.


## Corrected full owning-domain receipt on October 27

The corrected archive owning domain passed in33,520ms on46bfbfb5 in the canonical228-domain backend batch. The historical reported PID ownership remains unknown. The batch failed two different domains, so global coverage/deploy acceptance remains pending.
