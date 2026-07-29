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
 * of JSON across ~3.7k prod rows and one IndexedDBOrigin.databases row is 38MB;
 * once Prisma parses that JSONB into V8 objects the residency is multiple GB.
 * It only survived on a dev laptop, which has RAM to spare — memory usage grew
 * to fill whatever the box had, which is why the 8GB guests died too.
 *
 * These cases pin the bounded-memory contract at the owning boundary:
 *   case 1 — the reader is driven in pages; no page exceeds the page size.
 *   case 2 — peak simultaneous residency is O(page), NOT O(table).
 *   case 3 — every row still reaches the local upsert exactly once.
 *   case 4 — the local snapshot read is narrowed to the page (an unscoped
 *            snapshot re-materializes the whole table and re-breaks the fix).
 *   case 5 — a short final page terminates the loop.
 *   case 6 — an invalid page size is rejected rather than silently unpaged.
 */

import {
  syncOriginCredentials,
  syncPagedCredentials,
  type OriginModel,
} from '../../../scripts/seed-local-credentials';
import { createScopedBrowserAuthReaders } from '../../../scripts/cookie-domain-scope';
import type { LocalStorageOrigin } from '@prisma/client';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const USER_ID = 'seed-paging-user';
const TABLE_ROWS = 500;
const PAGE_SIZE = 50;

function makeOrigin(index: number): LocalStorageOrigin {
  return {
    id: `origin-${String(index).padStart(5, '0')}`,
    userId: USER_ID,
    origin: `https://origin-${index}.test`,
    entries: { k: `v${index}` } as never,
    hash: `hash-${index}`,
    updatedAt: new Date(0),
  } as LocalStorageOrigin;
}

/** A table that refuses to hand out more than one page at a time. */
function pagedTable(rows: LocalStorageOrigin[], observed: number[]) {
  return async (
    _where: Record<string, unknown>,
    page?: { skip: number; take: number }
  ): Promise<LocalStorageOrigin[]> => {
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

test('origin sync reads the remote table in bounded pages', async () => {
  const rows = Array.from({ length: TABLE_ROWS }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  const readers = createScopedBrowserAuthReaders(
    {
      cookie: async () => [],
      cookieBundle: async () => [],
      steelSessionAuth: async () => [],
      localStorageOrigin: pagedTable(rows, observed),
      indexedDBOrigin: async () => [],
      browserPermission: async () => [],
      cacheStorageOrigin: async () => [],
      browserPassword: async () => [],
      passkeyCredential: async () => [],
    },
    USER_ID,
    ['origin-1.test']
  );

  const model: OriginModel<LocalStorageOrigin> = {
    findMany: async () => [],
    upsert: async () => ({}),
  } as unknown as OriginModel<LocalStorageOrigin>;

  const synced = await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    (origins) => syncOriginCredentials(model, origins),
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

  const readers = createScopedBrowserAuthReaders(
    {
      cookie: async () => [],
      cookieBundle: async () => [],
      steelSessionAuth: async () => [],
      localStorageOrigin: pagedTable(rows, observed),
      indexedDBOrigin: async () => [],
      browserPermission: async () => [],
      cacheStorageOrigin: async () => [],
      browserPassword: async () => [],
      passkeyCredential: async () => [],
    },
    USER_ID,
    ['origin-1.test']
  );

  const model: OriginModel<LocalStorageOrigin> = {
    findMany: async () => [],
    upsert: async () => ({}),
  } as unknown as OriginModel<LocalStorageOrigin>;

  await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    async (origins) => {
      live = origins.length;
      peak = Math.max(peak, live);
      const n = await syncOriginCredentials(model, origins);
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

test('every row is upserted exactly once across pages', async () => {
  const rows = Array.from({ length: TABLE_ROWS }, (_, i) => makeOrigin(i));
  const observed: number[] = [];
  const upserted: string[] = [];

  const readers = createScopedBrowserAuthReaders(
    {
      cookie: async () => [],
      cookieBundle: async () => [],
      steelSessionAuth: async () => [],
      localStorageOrigin: pagedTable(rows, observed),
      indexedDBOrigin: async () => [],
      browserPermission: async () => [],
      cacheStorageOrigin: async () => [],
      browserPassword: async () => [],
      passkeyCredential: async () => [],
    },
    USER_ID,
    ['origin-1.test']
  );

  const model: OriginModel<LocalStorageOrigin> = {
    findMany: async () => [],
    upsert: async (args) => {
      upserted.push(args.where.userId_origin.origin);
      return {};
    },
  } as unknown as OriginModel<LocalStorageOrigin>;

  await syncPagedCredentials(
    (page) => readers.localStorageOrigin(page),
    (origins) => syncOriginCredentials(model, origins),
    PAGE_SIZE
  );

  assert(
    upserted.length === TABLE_ROWS,
    `expected ${TABLE_ROWS} upserts, got ${upserted.length} — paging must not drop or duplicate rows`
  );
  assert(
    new Set(upserted).size === TABLE_ROWS,
    'paging must not upsert the same origin twice (skip/take needs deterministic ordering)'
  );
});

test('local snapshot read is narrowed to the current page', async () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => makeOrigin(i));
  const snapshotWheres: Array<Record<string, unknown>> = [];

  const model: OriginModel<LocalStorageOrigin> = {
    findMany: async (args: { where: Record<string, unknown> }) => {
      snapshotWheres.push(args.where);
      return [];
    },
    upsert: async () => ({}),
  } as unknown as OriginModel<LocalStorageOrigin>;

  await syncOriginCredentials(model, page);

  assert(snapshotWheres.length === 1, 'expected exactly one snapshot read per page');
  const where = snapshotWheres[0] as { origin?: { in?: string[] } };
  assert(
    Array.isArray(where.origin?.in),
    'snapshot read must be narrowed by origin — an unscoped read re-materializes the whole ' +
      'local table on every page and restores O(table) peak memory'
  );
  assert(
    where.origin.in.length === PAGE_SIZE,
    `snapshot must be scoped to the page's ${PAGE_SIZE} origins, got ${where.origin.in.length}`
  );
});

test('a short final page ends the loop without an extra read', async () => {
  const total = PAGE_SIZE + 7;
  const rows = Array.from({ length: total }, (_, i) => makeOrigin(i));
  const observed: number[] = [];

  const model: OriginModel<LocalStorageOrigin> = {
    findMany: async () => [],
    upsert: async () => ({}),
  } as unknown as OriginModel<LocalStorageOrigin>;

  const synced = await syncPagedCredentials(
    async (page) => {
      const slice = rows.slice(page.skip, page.skip + page.take);
      observed.push(slice.length);
      return slice;
    },
    (origins) => syncOriginCredentials(model, origins),
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
