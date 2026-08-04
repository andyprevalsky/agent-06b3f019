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
 * `findMany()` before writing a single row. LocalStorageOrigin.entries spans
 * ~3.7k prod rows and the current largest IndexedDBOrigin value is only 13MB
 * compressed; Prisma still expands its nested JSON into >3.8GB of V8 objects.
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
 *
 * The Cookie table hit the same wall from the other side. A ~22k-cookie account
 * paged through Prisma forced a choice between ~880 production round trips (over
 * the deploy stack's 120s readiness contract) and a 239MB peak against the 230MB
 * seed ratchet. It now streams Postgres-to-Postgres with COPY, so the remaining
 * cases pin what that SQL must guarantee: suffix-safe domain scoping, escaped
 * literals, full-column fidelity, a natural-key merge, and a content-only diff.
 */

import {
  syncJsonTextOrigins,
  syncOriginCredentials,
  syncPagedCredentials,
  type OriginModel,
} from '../../../scripts/seed-local-credentials';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  cookieSourceCopySql,
  cookieTargetCopySql,
  jsonbOriginSourceCopySql,
  jsonbOriginTargetCopySql,
  pipeJsonbCopy,
  psqlDatabaseUrl,
} from '../../../scripts/seed-jsonb-stream';
import {
  createScopedBrowserAuthReaders,
  DEFAULT_COOKIE_PAGE_SIZE,
} from '../../../scripts/cookie-domain-scope';
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

/**
 * Interpret the generated domain predicate the way Postgres would.
 *
 * Asserting on substrings alone cannot prove suffix-safety — only evaluating the
 * whole OR-clause against a look-alike host can. Each clause is parsed back out
 * of the SQL and applied to a candidate domain.
 */
function cookieDomainPredicate(sql: string): (domain: string) => boolean {
  const clause = sql.match(/AND \((.*)\)\n/)?.[1];
  assert(clause !== undefined, 'expected a parenthesised domain clause in the cookie source SQL');
  const unquote = (literal: string) => literal.replaceAll("''", "'");
  const tests: Array<(domain: string) => boolean> = [];

  for (const part of clause.split(' OR ')) {
    const equals = part.match(/^"domain" = '((?:[^']|'')*)'$/);
    if (equals) {
      const expected = unquote(equals[1]);
      tests.push((domain) => domain === expected);
      continue;
    }
    const like = part.match(/^"domain" LIKE '((?:[^']|'')*)' ESCAPE '\\'$/);
    assert(like !== null, `unrecognised cookie domain clause: ${part}`);
    // Translate the LIKE pattern (with ESCAPE '\') into an equivalent regex.
    const pattern = unquote(like[1]);
    let regex = '';
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      if (character === '\\') {
        index += 1;
        regex += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else if (character === '%') regex += '[\\s\\S]*';
      else if (character === '_') regex += '[\\s\\S]';
      else regex += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const compiled = new RegExp(`^${regex}$`);
    tests.push((domain) => compiled.test(domain));
  }

  assert(tests.length > 0, 'expected at least one cookie domain clause');
  return (domain) => tests.some((matches) => matches(domain));
}

test('streamed cookie copy scopes domains suffix-safely', () => {
  const sql = cookieSourceCopySql('dev-user', ['doordash.com']);

  assert(sql.includes(`"userId" = 'dev-user'`), 'cookie COPY must scope the read to one user');
  assert(sql.includes(`FROM "Cookie"`), 'cookie COPY must read the Cookie table');

  const matches = cookieDomainPredicate(sql);
  for (const domain of ['doordash.com', '.doordash.com', 'www.doordash.com', 'a.b.doordash.com']) {
    assert(matches(domain), `cookie scope must include ${domain}`);
  }
  for (const domain of [
    'evil-doordash.com',
    'evildoordash.com',
    'doordash.com.evil.com',
    'amazon.com',
  ]) {
    assert(
      !matches(domain),
      `cookie scope must NOT include the look-alike ${domain} — a benchmark fixture would ` +
        'receive another site’s live session cookies'
    );
  }
});

test('streamed cookie copy escapes SQL literals and LIKE wildcards', () => {
  const sql = cookieSourceCopySql("user'quoted", ["o'reilly%_.com"]);

  assert(sql.includes(`"userId" = 'user''quoted'`), 'cookie COPY must quote the user id');
  assert(
    sql.includes(`"domain" = 'o''reilly%_.com'`),
    'an equality clause must carry the domain verbatim with quotes doubled'
  );
  assert(
    sql.includes(`"domain" LIKE '%.o''reilly\\%\\_.com' ESCAPE '\\'`),
    'a LIKE clause must escape % and _ so a wildcard in the domain cannot widen the scope'
  );
  // The literal domain still matches itself once escaped; a wildcard expansion would not.
  const matches = cookieDomainPredicate(sql);
  assert(matches("www.o'reilly%_.com"), 'the escaped pattern must still match the literal domain');
  assert(!matches("www.o'reillyXY.com"), 'an escaped % must not be interpreted as a LIKE wildcard');
});

test('an unscoped cookie stream reads the whole user table in one round trip', () => {
  const sql = cookieSourceCopySql('dev-user', []);
  assert(!sql.includes('AND ('), 'no declared domains must not narrow the cookie read');
  assert(
    !/LIMIT|OFFSET/i.test(sql),
    'the cookie stream must not page — paging a 22k-cookie account is the ~880 round trips ' +
      'that broke the deploy stack’s 120s readiness contract'
  );
  assert(
    sql.includes('TO STDOUT WITH (FORMAT csv)'),
    'cookies must leave the source as a CSV COPY stream so no row enters the V8 heap'
  );
});

test('streamed cookie copy carries every column so the seed stays byte-faithful', () => {
  const sql = cookieSourceCopySql('dev-user', []);
  // Every Cookie column in the Prisma model. measure-seed-memory.sh fingerprints
  // `to_jsonb(row) - 'id'` on both sides, so an omitted column is lost user data.
  for (const column of [
    'id',
    'userId',
    'domain',
    'name',
    'path',
    'value',
    'expiresUtc',
    'isSecure',
    'isHttpOnly',
    'browserSource',
    'syncedAt',
    'creationUtc',
    'hasExpires',
    'isPersistent',
    'lastAccessUtc',
    'lastUpdateUtc',
    'priority',
    'sameSite',
    'sourcePort',
    'sourceScheme',
    'topFrameSiteKey',
    'browserProfile',
  ]) {
    assert(sql.includes(`"${column}"`), `cookie COPY must carry the "${column}" column`);
  }
});

test('streamed cookie copy merges on the natural key and only rewrites changed content', () => {
  const sql = cookieTargetCopySql();

  assert(
    sql.includes(
      'CREATE TEMP TABLE "_SeedCookie" (LIKE "Cookie" INCLUDING DEFAULTS) ON COMMIT DROP'
    )
  );
  assert(
    sql.includes('COPY "_SeedCookie"') && sql.includes('FROM STDIN WITH (FORMAT csv)'),
    'cookies must land in a temp stage table via COPY FROM STDIN'
  );
  assert(
    sql.includes(
      'ON CONFLICT ("userId", "domain", "name", "path", "topFrameSiteKey", "browserSource", ' +
        '"browserProfile") DO UPDATE SET'
    ),
    'target COPY must merge by the Cookie model’s natural @@unique identity, matching the ' +
      'Prisma upsert it replaces'
  );
  assert(
    sql.includes(`SELECT 'SEED_STREAM_COUNT=' || count(*) FROM "_SeedCookie"`),
    'target COPY must report the streamed row count the caller parses'
  );

  const update = sql.match(/DO UPDATE SET([\s\S]*?)WHERE \(/)?.[1];
  assert(update !== undefined, 'expected a DO UPDATE SET body');
  assert(!/"id"\s*=/.test(update), 'target COPY must preserve a pre-existing local primary id');
  for (const identity of [
    'userId',
    'domain',
    'name',
    'path',
    'topFrameSiteKey',
    'browserSource',
    'browserProfile',
  ]) {
    assert(
      !update.includes(`"${identity}" =`),
      `target COPY must not rewrite the conflict key column "${identity}"`
    );
  }

  const guard = sql.match(/WHERE \(([\s\S]*?)\);/)?.[1];
  assert(guard !== undefined, 'expected an IS DISTINCT FROM guard on the merge');
  assert(
    sql.includes('IS DISTINCT FROM'),
    'the merge must skip rows whose content is unchanged — rewriting all 22k rows on every ' +
      'warm sync is the behavior cookieContent() exists to avoid'
  );
  // Exactly the columns cookieContent() hashes in seed-local-credentials.ts.
  for (const column of [
    'value',
    'expiresUtc',
    'isSecure',
    'isHttpOnly',
    'creationUtc',
    'hasExpires',
    'isPersistent',
    'lastAccessUtc',
    'lastUpdateUtc',
    'priority',
    'sameSite',
    'sourcePort',
    'sourceScheme',
  ]) {
    assert(
      guard.includes(`existing."${column}"`) && guard.includes(`EXCLUDED."${column}"`),
      `the content diff must compare "${column}", exactly as cookieContent() does`
    );
    assert(
      update.includes(`"${column}" = EXCLUDED."${column}"`),
      `a changed "${column}" must sync`
    );
  }
  assert(
    !guard.includes('syncedAt'),
    'syncedAt must not trigger a rewrite on its own — cookieContent() excludes it'
  );
});

test('the default cookie page stays bounded now that cookies stream', () => {
  // The seed no longer pages cookies at all (COPY streams them in one round
  // trip), so this default is once again purely a residency bound. It was
  // inflated to 500 only to buy back round trips, which cost 239MB peak RSS
  // against a 230MB ratchet.
  assert(
    DEFAULT_COOKIE_PAGE_SIZE <= 100,
    `default cookie page must remain memory-bounded, got ${DEFAULT_COOKIE_PAGE_SIZE}`
  );
});

test('large JSONB origins cross the seed boundary as text without fidelity loss', async () => {
  const payloads = [
    JSON.stringify([{ database: 'small', records: [{ key: 1, value: 'one' }] }]),
    JSON.stringify([
      {
        database: 'large',
        records: [{ key: 2, value: 'x'.repeat(1024 * 1024) }],
      },
    ]),
    JSON.stringify([{ database: 'last', records: [{ key: 3, value: 'three' }] }]),
  ];
  const rows = payloads.map((payload, index) => ({
    id: `json-origin-${index}`,
    userId: USER_ID,
    origin: `https://json-origin-${index}.test`,
    payload,
    hash: `json-hash-${index}`,
    updatedAt: new Date(index * 1000),
  }));
  const readSizes: number[] = [];
  const written: typeof rows = [];

  const synced = await syncJsonTextOrigins(
    async ({ afterId, take }) => {
      const start = afterId === undefined ? 0 : rows.findIndex((row) => row.id === afterId) + 1;
      const page = rows.slice(start, start + take);
      readSizes.push(page.length);
      return page;
    },
    async () => null,
    async (row) => {
      written.push(row);
    },
    1
  );

  assert(synced === rows.length, `expected ${rows.length} rows synced, got ${synced}`);
  assert(
    Math.max(...readSizes) === 1,
    `JSONB text transport must hold one payload at a time, saw page size ${Math.max(...readSizes)}`
  );
  assert(
    written.every((row, index) => row.payload === payloads[index]),
    'JSONB text transport must preserve every payload byte without parsing, sampling, or truncation'
  );
});

test('oversized JSONB crosses the database boundary incrementally without fidelity loss', async () => {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const chunkCount = 1024;
  const expected = createHash('sha256');
  for (let index = 0; index < chunkCount; index += 1) expected.update(chunk);

  let largestChunk = 0;
  const actual = createHash('sha256');
  const source = Readable.from(
    (async function* streamPayload() {
      for (let index = 0; index < chunkCount; index += 1) yield chunk;
    })()
  );
  const target = new Writable({
    write(data: Buffer, _encoding, callback) {
      largestChunk = Math.max(largestChunk, data.byteLength);
      actual.update(data);
      callback();
    },
  });

  await pipeJsonbCopy(source, target);

  assert(
    largestChunk <= chunk.byteLength,
    `stream transport must not coalesce the 64MB payload; largest chunk was ${largestChunk} bytes`
  );
  assert(
    actual.digest('hex') === expected.digest('hex'),
    'stream transport must preserve every payload byte without parsing, sampling, or truncation'
  );
});

test('streamed JSONB copy stays scoped and preserves local identities on merge', async () => {
  const sourceSql = jsonbOriginSourceCopySql('IndexedDBOrigin', "user'quoted", ['amazon.com']);
  const targetSql = jsonbOriginTargetCopySql('IndexedDBOrigin');

  assert(sourceSql.includes(`"userId" = 'user''quoted'`), 'source COPY must quote the user id');
  assert(
    sourceSql.includes(`"origin" LIKE '%://amazon.com'`),
    'source COPY must retain exact-host origin scoping'
  );
  assert(
    sourceSql.includes(`"origin" LIKE '%.amazon.com/%'`),
    'source COPY must retain subdomain/path origin scoping'
  );
  assert(
    targetSql.includes('ON CONFLICT ("userId", "origin") DO UPDATE SET'),
    'target COPY must merge by the same natural identity as the Prisma path'
  );
  assert(
    !targetSql.match(/DO UPDATE SET[\s\S]*"id"\s*=/),
    'target COPY must preserve a pre-existing local primary id'
  );
  assert(
    psqlDatabaseUrl(
      'postgresql://postgres:postgres@localhost:5432/victoria?connection_limit=50&pool_timeout=30&sslmode=require'
    ) === 'postgresql://postgres:postgres@localhost:5432/victoria?sslmode=require',
    'psql transport must strip Prisma-only URL parameters while preserving libpq parameters'
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
