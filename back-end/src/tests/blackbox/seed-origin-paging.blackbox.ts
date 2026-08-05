#!/usr/bin/env tsx
/**
 * Blackbox: the browser-auth origin sync must stay memory-bounded.
 *
 * RCA cement (descend daily, epoch 1). All 44 cloud bench guests were
 * OOM-killed during first-run seed — three SIGKILLs each, then "aborting
 * stack", so the whole slice returned 0/44 with no benchmark verdict.
 *
 *   [172.798] Out of memory: Killed process 1487 (node) anon-rss:3482344kB   (4GB guest)
 *   [155.271] Out of memory: Killed process 1507 (node) anon-rss:5946368kB   (8GB guest)
 *
 * Cause: `seed-local.ts` read whole blob-bearing tables with an unpaged
 * `findMany()` before writing a single row. LocalStorageOrigin.entries is 84MB
 * of JSON across ~3.7k prod rows and one IndexedDBOrigin.databases row is 41MB;
 * once Prisma parses that JSONB into V8 objects the residency is multiple GB.
 * It only survived on a dev laptop, which has RAM to spare — memory usage grew
 * to fill whatever the box had, which is why the 8GB guests died too.
 *
 * These cases pin the ROW-COUNT half of the bounded-memory contract:
 *   case 1 — the reader is driven in pages; no page exceeds the page size.
 *   case 2 — peak simultaneous residency is O(page), NOT O(table).
 *   case 3 — every row still reaches the local write exactly once.
 *   case 4 — the local snapshot read is narrowed to the page (an unscoped
 *            snapshot re-materializes the whole table and re-breaks the fix).
 *   case 5 — a short final page terminates the loop.
 *   case 6 — an invalid page size is rejected rather than silently unpaged.
 *   case 7 — neither the page read nor the snapshot read carries the payload
 *            column, and an unchanged row transfers no payload at all.
 *
 * The BYTE-SIZE half — that one 40MB row cannot cost gigabytes — is pinned
 * against real Postgres by `seed-blob-origin-memory.blackbox.ts` (descend I-04).
 */

import {
  ORIGIN_BLOB_COLUMNS,
  syncOriginBlobCredentials,
  syncPagedCredentials,
  type OriginMetaRow,
  type RawSqlClient,
  type TransactionalSqlClient,
} from '../../../scripts/seed-local-credentials';
import { createScopedBrowserAuthReaders } from '../../../scripts/cookie-domain-scope';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const USER_ID = 'seed-paging-user';
const TABLE_ROWS = 500;
const PAGE_SIZE = 50;

function makeOrigin(index: number): OriginMetaRow {
  return {
    id: `origin-${String(index).padStart(5, '0')}`,
    userId: USER_ID,
    origin: `https://origin-${index}.test`,
    hash: `hash-${index}`,
    updatedAt: new Date(0),
  };
}

type RecordedQuery = { sql: string; params: unknown[] };

/**
 * Stand-ins for the two `PrismaClient` raw-SQL endpoints. The remote side hands
 * back a payload only when it is actually asked for, so "was this row's blob
 * fetched?" is directly observable.
 */
function fakeEndpoints(localHashes: Map<string, string> = new Map()) {
  const snapshotReads: RecordedQuery[] = [];
  const payloadReads: RecordedQuery[] = [];
  const writes: RecordedQuery[] = [];

  const payload = '{"k":"v"}';
  const remote: RawSqlClient = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      payloadReads.push({ sql, params });
      // The byte-budgeted batch read: every requested id fits, so all of them
      // come back with a payload in this single round trip.
      return (params[0] as string[]).map((id) => ({
        id,
        payload_length: payload.length,
        payload,
      })) as never;
    },
    $executeRawUnsafe: async () => {
      throw new Error('the source database must never be written to');
    },
  };

  const local: TransactionalSqlClient = {
    $transaction: async <T>(fn: (tx: RawSqlClient) => Promise<T>): Promise<T> => fn(local),
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      snapshotReads.push({ sql, params });
      const origins = (params[1] as string[]) ?? [];
      return origins
        .filter((origin) => localHashes.has(origin))
        .map((origin) => ({
          userId: USER_ID,
          origin,
          hash: localHashes.get(origin) as string,
        })) as never;
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      writes.push({ sql, params });
      return 1;
    },
  };

  return { remote, local, snapshotReads, payloadReads, writes };
}

/** A table that refuses to hand out more than one page at a time. */
function pagedTable(rows: OriginMetaRow[], observed: number[]) {
  return async (
    _where: Record<string, unknown>,
    page?: { skip: number; take: number }
  ): Promise<OriginMetaRow[]> => {
    if (!page) {
      // The pre-fix contract: the whole table in one array. Recording this as a
      // page of `rows.length` is what makes case 2 fail on the buggy revision.
      observed.push(rows.length);
      return rows;
    }
    const slice = rows.slice(page.skip, page.skip + page.take);
    observed.push(slice.length);
    return slice;
  };
}

function readersFor(localStorageOrigin: ReturnType<typeof pagedTable>) {
  return createScopedBrowserAuthReaders(
    {
      cookie: async () => [],
      cookieBundle: async () => [],
      steelSessionAuth: async () => [],
      localStorageOrigin,
      indexedDBOrigin: async () => [],
      browserPermission: async () => [],
      cacheStorageOrigin: async () => [],
      browserPassword: async () => [],
      passkeyCredential: async () => [],
    },
    USER_ID,
    ['origin-1.test']
  );
}

test('origin sync reads the remote table in bounded pages', async () => {
  const rows = Array.from({ length: TABLE_ROWS }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  const readers = readersFor(pagedTable(rows, observed));
  const { remote, local } = fakeEndpoints();

  const synced = await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    (origins) => syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', origins),
    PAGE_SIZE
  );

  assert(synced === TABLE_ROWS, `expected all ${TABLE_ROWS} rows synced, got ${synced}`);
  assert(observed.length > 1, `expected multiple pages, got ${observed.length} read(s)`);
  const biggest = Math.max(...observed);
  assert(
    biggest <= PAGE_SIZE,
    `no read may exceed the page size — largest read was ${biggest} rows (page size ${PAGE_SIZE})`
  );
});

test('peak simultaneous residency is bounded by page size, not table size', async () => {
  const rows = Array.from({ length: TABLE_ROWS }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  let live = 0;
  let peak = 0;
  const readers = readersFor(pagedTable(rows, observed));
  const { remote, local } = fakeEndpoints();

  await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    async (origins) => {
      live = origins.length;
      peak = Math.max(peak, live);
      const n = await syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', origins);
      live = 0;
      return n;
    },
    PAGE_SIZE
  );

  assert(
    peak <= PAGE_SIZE,
    `peak resident rows must stay within one page — held ${peak} of ${TABLE_ROWS} rows at once ` +
      `(this is the OOM that killed all 44 bench guests)`
  );
});

test('every row is written exactly once across pages', async () => {
  const rows = Array.from({ length: TABLE_ROWS }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  const readers = readersFor(pagedTable(rows, observed));
  const { remote, local, writes } = fakeEndpoints();

  await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    (origins) => syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', origins),
    PAGE_SIZE
  );

  const written = writes.map((write) => write.params[2] as string);
  assert(
    written.length === TABLE_ROWS,
    `expected ${TABLE_ROWS} writes, got ${written.length} — paging must not drop or duplicate rows`
  );
  assert(
    new Set(written).size === TABLE_ROWS,
    'paging must not write the same origin twice (skip/take needs deterministic ordering)'
  );
});

test('local snapshot read is narrowed to the current page', async () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => makeOrigin(i));
  const { remote, local, snapshotReads } = fakeEndpoints();

  await syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', page);

  assert(snapshotReads.length === 1, 'expected exactly one snapshot read per page');
  const origins = snapshotReads[0].params[1] as string[];
  assert(
    Array.isArray(origins),
    'snapshot read must be narrowed by origin — an unscoped read re-materializes the whole ' +
      'local table on every page and restores O(table) peak memory'
  );
  assert(
    origins.length === PAGE_SIZE,
    `snapshot must be scoped to the page's ${PAGE_SIZE} origins, got ${origins.length}`
  );
});

test('a short final page ends the loop without an extra read', async () => {
  const total = PAGE_SIZE + 7;
  const rows = Array.from({ length: total }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  const { remote, local } = fakeEndpoints();

  const synced = await syncPagedCredentials(
    async (page) => {
      const slice = rows.slice(page.skip, page.skip + page.take);
      observed.push(slice.length);
      return slice;
    },
    (origins) => syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', origins),
    PAGE_SIZE
  );

  assert(synced === total, `expected ${total} synced, got ${synced}`);
  assert(
    observed.length === 2,
    `a short final page must terminate the loop; expected 2 reads, got ${observed.length}`
  );
});

test('an invalid page size is rejected instead of silently reading unpaged', async () => {
  let threw = false;
  try {
    await syncPagedCredentials(
      async () => [],
      async () => 0,
      0
    );
  } catch {
    threw = true;
  }
  assert(threw, 'page size 0 must throw — silently falling back to an unpaged read is the bug');
});

test('the payload column is read only for rows whose hash actually changed', async () => {
  const page = Array.from({ length: 4 }, (_, i) => makeOrigin(i));
  // Two rows already match locally; only the other two may cost a payload read.
  const localHashes = new Map([
    [page[0].origin, page[0].hash],
    [page[2].origin, page[2].hash],
  ]);
  const { remote, local, snapshotReads, payloadReads, writes } = fakeEndpoints(localHashes);

  await syncOriginBlobCredentials(remote, local, 'LocalStorageOrigin', page);

  const payloadColumn = ORIGIN_BLOB_COLUMNS.LocalStorageOrigin;
  assert(
    !snapshotReads[0].sql.includes(payloadColumn),
    `the snapshot read must not touch "${payloadColumn}" — pulling the payload just to compare ` +
      'hashes is what made peak memory scale with the blob instead of the row count'
  );
  assert(
    payloadReads.length === 1,
    `payloads must be batched into one round trip per pass, got ${payloadReads.length} — one ` +
      'read per row is what made a full prod sync take hours instead of minutes'
  );
  assert(writes.length === 2, `expected 2 writes for 2 changed rows, got ${writes.length}`);
  const fetchedIds = payloadReads[0].params[0] as string[];
  assert(
    fetchedIds.length === 2 && fetchedIds.includes(page[1].id) && fetchedIds.includes(page[3].id),
    `the payload read must ask for exactly the changed rows, got ${JSON.stringify(fetchedIds)} — ` +
      'an unchanged origin must transfer no payload at all'
  );
});

async function main(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`❌ ${name}\n   ${(err as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
