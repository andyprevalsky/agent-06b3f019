#!/usr/bin/env tsx
/**
 * The per-root archive manifest lock pins one pooled connection for its whole
 * operation, and the operation's own queries need another. Unbounded, the lock
 * holders plus the callers queued behind them inside Postgres pinned every
 * connection, so no holder could run a query until the 30 s pool timeout: two
 * concurrent agent deletes starved a 4-connection pool for about 105 s
 * (2026-10-07, backend coverage; every other request in that window failed).
 *
 * This runs more concurrent locked operations than the pool has connections,
 * on shared and distinct roots, each issuing one ordinary query inside the
 * lock. All of them must finish promptly and none may wait on the pool.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';

// A pool smaller than the number of concurrent lock users. Must be set before
// the database provider builds its client; a limit already in the URL (the
// coverage runner sets one) wins over DB_CONNECTION_LIMIT, so replace it there.
const POOL_SIZE = 3;
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
databaseUrl.searchParams.set('connection_limit', String(POOL_SIZE));
process.env.DATABASE_URL = databaseUrl.toString();

const OPERATIONS = 8;
const DISTINCT_ROOTS = 4;
// The buggy path cannot finish before Prisma's 30 s pool timeout.
const PROMPT_COMPLETION_MS = 15_000;

async function main(): Promise<void> {
  const { prisma, databasePoolLimit } = await import('../../providers/database');
  const { withArchiveManifestLock } = await import('../../providers/traceArchiveManifest');
  assert.strictEqual(
    databasePoolLimit(),
    POOL_SIZE,
    'the test pool must be the small one configured above'
  );

  const roots = Array.from({ length: DISTINCT_ROOTS }, () => `manifest-lock-pool-${randomUUID()}`);
  let insideLock = 0;
  let mostInsideLock = 0;
  const started = Date.now();
  try {
    const results = await Promise.all(
      Array.from({ length: OPERATIONS }, (_, index) =>
        withArchiveManifestLock(roots[index % DISTINCT_ROOTS]!, async (ownership) => {
          insideLock += 1;
          mostInsideLock = Math.max(mostInsideLock, insideLock);
          try {
            // Overlap the operations, then do what every real caller does: a
            // query on the shared client while this lock's transaction is open.
            await new Promise((resolve) => setTimeout(resolve, 50));
            const rows = await prisma.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`;
            await ownership.assertOwned();
            return rows[0]?.value;
          } finally {
            insideLock -= 1;
          }
        })
      )
    );
    const elapsedMs = Date.now() - started;
    assert.deepStrictEqual(
      results,
      Array.from({ length: OPERATIONS }, () => 1)
    );
    assert.ok(
      elapsedMs < PROMPT_COMPLETION_MS,
      `locked operations waited on the connection pool: ${elapsedMs}ms for ${OPERATIONS} operations`
    );
    // Every open lock pins a connection and needs one more for its own queries,
    // so the locks held at once must leave the pool room for those queries.
    assert.ok(
      mostInsideLock * 2 <= databasePoolLimit(),
      `${mostInsideLock} manifest locks were open at once on a ${databasePoolLimit()}-connection pool`
    );
    process.stdout.write(
      `PASS ${OPERATIONS} manifest-locked operations on a ${POOL_SIZE}-connection pool finished in ${elapsedMs}ms ` +
        `(at most ${mostInsideLock} open at once)\n`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
