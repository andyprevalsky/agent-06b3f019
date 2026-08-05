#!/usr/bin/env tsx
/**
 * Blackbox: transferring a blob-bearing browser-auth origin row must cost far
 * less heap than the row itself is large.
 *
 * RCA cement (descend, I-04). `browser-biometrics-webdecoy` produced NO verdict
 * on the cloud bench guest: its live fixture calls `_sync_browser_credentials()`
 * → `seed-local.ts --credentials-only`, whose stdout ends abruptly right after
 * "LocalStorage: 3733 synced" with no error and no stderr — the SIGKILL/OOM
 * signature. The next table is IndexedDB, whose largest prod row is a single
 * 41MB JSON blob (`https://drive.google.com`, 13MB TOAST-compressed).
 *
 * `seed-origin-paging.blackbox.ts` already pins the ROW-COUNT bound (peak is
 * O(page), not O(table)). That is necessary but not sufficient: at page size 1
 * peak was still bounded by the LARGEST SINGLE ROW, because both the remote read
 * and the local write went through Prisma's JSON codec — the JSONB was decoded
 * into a deep V8 object graph (hundreds of thousands of tiny objects and
 * strings), then re-encoded to send back. Measured on a ~50MB row: the child
 * OOMs outright under a 256MB heap, and even given enough heap to finish it
 * peaks at 3995MB RSS for that one row.
 *
 * This suite pins the BYTE-SIZE bound that `seed-origin-paging` cannot see:
 *   case 1 — a realistically-shaped ~50MB origin blob transfers end to end
 *            inside a hard {@link CHILD_HEAP_MB}MB V8 heap, through the real
 *            production sync path, against real Postgres.
 *   case 2 — the transferred blob is byte-identical to the source (compared as
 *            server-side md5 of `databases::text`, so neither side of the test
 *            has to materialize it either).
 *   case 3 — peak RSS stays inside {@link MAX_PEAK_RSS_MB}, i.e. the cost is
 *            the chunk size and fixed process overhead, not the row size.
 *
 * Cases 1 and 3 are the regression guard. On the pre-fix revision the child dies
 * with "JavaScript heap out of memory" — the exact failure the bench guest hit.
 */

import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabase } from './assertLocalDatabase';
import { createScopedBrowserAuthReaders } from '../../../scripts/cookie-domain-scope';
import {
  ORIGIN_META_SELECT,
  syncOriginBlobCredentials,
  syncPagedCredentials,
} from '../../../scripts/seed-local-credentials';

assertLocalDatabase();

const SRC_SCHEMA = 'seed_blob_memory_src';
const DST_SCHEMA = 'seed_blob_memory_dst';
const USER_ID = 'seed-blob-memory-user';
const BIG_ORIGIN = 'https://blob-big.seed-memory.test';

/**
 * Record count for the synthetic blob: ~145 JSON bytes per record, so 360k
 * records ≈ 50MB — comfortably past the real 41MB `https://drive.google.com`
 * prod row that killed the guest. The shape (databases[] → objectStores[] →
 * records[] → {key, value:{key, value}}) mirrors that row, because it is the
 * OBJECT COUNT, not the byte count, that explodes when Prisma decodes it.
 */
const BLOB_RECORDS = 360_000;

/**
 * The V8 heap the child gets. The pre-fix path OOMs here (it needed >256MB just
 * for the decode) while the fixed path clears it with room to spare — measured
 * green at 96MB. Raising this to make a failure go away would delete the entire
 * contract this suite exists to hold.
 */
const CHILD_HEAP_MB = 256;

/**
 * Total resident set the transfer may reach. The bench guest is
 * shared-cpu-2x/4096MB and is simultaneously running Postgres, the backend, a
 * Temporal worker and a browser stack, so a transfer costing gigabytes is a
 * guaranteed SIGKILL — pre-fix this measured 3995MB of RSS for one row, which
 * is exactly why browser-biometrics-webdecoy returned no verdict. Post-fix the
 * same row measures ~292MB, essentially all of it fixed process overhead (two
 * Prisma engines) rather than payload, so this budget has ~2x headroom.
 */
const MAX_PEAK_RSS_MB = 600;

/** Small rows either side of the big one so paging is genuinely exercised. */
const SMALL_ORIGINS = [
  'https://blob-small-a.seed-memory.test',
  'https://blob-small-b.seed-memory.test',
  'https://blob-small-c.seed-memory.test',
];

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function schemaUrl(schema: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set('schema', schema);
  return url.toString();
}

// ── Child mode: run the real sync inside the constrained heap ────────────────

async function runChildSync(): Promise<void> {
  const remote = new PrismaClient({ datasources: { db: { url: schemaUrl(SRC_SCHEMA) } } });
  const local = new PrismaClient({ datasources: { db: { url: schemaUrl(DST_SCHEMA) } } });

  let peakRssMb = 0;
  const sampler = setInterval(() => {
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1024 / 1024);
  }, 25);

  try {
    // Exactly the production wiring from scripts/seed-local.ts: scoped reader →
    // paged transfer → origin upsert, at the production blob page size of 1.
    const readers = createScopedBrowserAuthReaders(
      {
        cookie: async () => [],
        cookieBundle: async () => [],
        steelSessionAuth: async () => [],
        localStorageOrigin: async () => [],
        indexedDBOrigin: (where, page) =>
          remote.indexedDBOrigin.findMany({
            where: where as never,
            ...(page ? { skip: page.skip, take: page.take, orderBy: { id: 'asc' as const } } : {}),
            select: ORIGIN_META_SELECT,
          }),
        browserPermission: async () => [],
        cacheStorageOrigin: async () => [],
        browserPassword: async () => [],
        passkeyCredential: async () => [],
      },
      USER_ID,
      []
    );

    const synced = await syncPagedCredentials(
      (page) => readers.indexedDBOrigin(page),
      (origins) => syncOriginBlobCredentials(remote, local, 'IndexedDBOrigin', origins),
      1
    );

    clearInterval(sampler);
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1024 / 1024);
    process.stdout.write(
      `child: synced ${synced} origin(s); peak rss ${peakRssMb.toFixed(0)}MB ` +
        `(heap cap ${CHILD_HEAP_MB}MB)\n`
    );
  } finally {
    clearInterval(sampler);
    await remote.$disconnect();
    await local.$disconnect();
  }
}

// ── Parent mode ──────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function createOriginTable(schema: string): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."IndexedDBOrigin" (
      id text PRIMARY KEY,
      "userId" text NOT NULL,
      origin text NOT NULL,
      databases jsonb NOT NULL,
      hash text NOT NULL,
      "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    )`);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX "${schema}_origin_key" ON "${schema}"."IndexedDBOrigin" ("userId", origin)`
  );
}

/**
 * Built entirely server-side: the test process must never hold the blob either,
 * or the fixture would be its own OOM.
 */
async function seedSource(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${SRC_SCHEMA}"."IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
     SELECT 'blob-big', $1, $2,
       jsonb_build_array(jsonb_build_object(
         'name', 'DocsErrors',
         'objectStores', jsonb_build_array(jsonb_build_object(
           'name', 'Errors',
           'records', (
             SELECT jsonb_agg(jsonb_build_object(
               'key', 'record-key-' || i,
               'value', jsonb_build_object(
                 'key', 'record-key-' || i,
                 'value', md5(i::text) || md5((i * 7)::text)
               )
             ))
             FROM generate_series(1, ${BLOB_RECORDS}) i
           )
         ))
       )),
       'blob-big-hash', now()`,
    USER_ID,
    BIG_ORIGIN
  );
  for (const [index, origin] of SMALL_ORIGINS.entries()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${SRC_SCHEMA}"."IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5, now())`,
      `blob-small-${index}`,
      USER_ID,
      origin,
      JSON.stringify([{ name: `store-${index}`, objectStores: [] }]),
      `blob-small-hash-${index}`
    );
  }
}

async function dropSchemas(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SRC_SCHEMA}" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${DST_SCHEMA}" CASCADE`);
}

async function originDigests(schema: string): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ origin: string; digest: string }>>(
    `SELECT origin, md5(databases::text) || ':' || length(databases::text)::text AS digest
     FROM "${schema}"."IndexedDBOrigin" ORDER BY origin`
  );
  return new Map(rows.map((row) => [row.origin, row.digest]));
}

let childStdout = '';
let childStderr = '';
let childCode: number | null = null;

async function runChildProcess(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,
        '--import',
        'tsx',
        new URL(import.meta.url).pathname,
        '--child',
      ],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', (chunk) => {
      childStdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      childStderr += String(chunk);
    });
    child.on('close', (code) => {
      childCode = code;
      resolvePromise();
    });
  });
}

test(`a ~40MB origin blob transfers inside a ${CHILD_HEAP_MB}MB heap`, async () => {
  assert(
    childCode === 0,
    `the blob-origin sync must survive a ${CHILD_HEAP_MB}MB heap — child exited ${childCode}.\n` +
      `--- child stdout ---\n${childStdout}\n--- child stderr (tail) ---\n` +
      `${childStderr.split('\n').slice(-25).join('\n')}\n` +
      'This is the OOM that left browser-biometrics-webdecoy with no verdict: peak heap must ' +
      'be bounded by a constant multiple of the blob BYTES, not by the parsed object graph.'
  );
});

test('every origin lands byte-identical', async () => {
  const src = await originDigests(SRC_SCHEMA);
  const dst = await originDigests(DST_SCHEMA);
  assert(
    dst.size === src.size,
    `expected ${src.size} origin(s) synced, got ${dst.size} — a memory fix may not drop rows`
  );
  for (const [origin, digest] of src) {
    assert(
      dst.get(origin) === digest,
      `origin ${origin} did not round-trip byte-identically: source ${digest}, local ${dst.get(
        origin
      )}`
    );
  }
});

test(`peak RSS stays under ${MAX_PEAK_RSS_MB}MB — the guest has no more to give`, async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ chars: number }>>(
    `SELECT length(databases::text) AS chars FROM "${SRC_SCHEMA}"."IndexedDBOrigin"
     WHERE origin = $1`,
    BIG_ORIGIN
  );
  const chars = Number(rows[0]?.chars ?? 0);
  assert(
    chars > 40_000_000,
    `fixture blob must exceed the largest real prod row (41MB) to prove the bound; got ${chars} chars`
  );
  const peak = /peak rss (\d+)MB/.exec(childStdout);
  assert(peak, `child did not report peak rss; stdout was:\n${childStdout}`);
  const peakMb = Number(peak[1]);
  assert(
    peakMb <= MAX_PEAK_RSS_MB,
    `peak rss ${peakMb}MB for a ${(chars / 1024 / 1024).toFixed(0)}MB blob exceeds the ` +
      `${MAX_PEAK_RSS_MB}MB budget. Cost must scale with the chunk size, not with the row: a ` +
      'peak proportional to the blob means it is being materialized whole again.'
  );
});

async function main(): Promise<void> {
  if (process.argv.includes('--child')) {
    await runChildSync();
    return;
  }

  let failed = 0;
  try {
    await dropSchemas();
    await createOriginTable(SRC_SCHEMA);
    await createOriginTable(DST_SCHEMA);
    await seedSource();
    await runChildProcess();

    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`✅ ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`❌ ${name}\n   ${(err as Error).message}`);
      }
    }
  } finally {
    await dropSchemas();
    await prisma.$disconnect();
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
