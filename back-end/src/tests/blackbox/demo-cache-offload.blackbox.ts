/**
 * Large browser_http Fast Mode cache values live in Storage behind a pointer
 * (FastModeCacheEntry was 50 GB of a 61 GB production database), and every
 * reader still gets the identical value:
 *
 *   set ≥ 64 KB browser_http ─► Storage object (sha256 path) + row pointer
 *   get ─► rehydrated, sha256-verified value      missing object ─► miss
 *   identical re-record ─► no upload, no row write
 *   existing inline rows ─► batched backfill (dry run first, idempotent,
 *                           confined to this run's key prefix)
 *
 * Open order: db.$connect() ─► engine TLS probe setenv()s SSL_CERT_FILE once
 *             ─► only then import the store (app + DEMO-cache clients).
 * A client constructed before that first connect reads process.env while the
 * probe writes it (getenv/setenv race, a silent SIGSEGV; see RCA
 * 2026-11-08-prisma-engine-tls-probe-setenv-raced-second-client-getenv).
 *
 * Storage is an in-memory fake behind the Supabase client's fetch; the cache
 * database must be the local one.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectThenOpen } from '../../../scripts/seed-local-helpers';

const cacheUrl = process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL;
assert(cacheUrl, 'the blackbox runner must set FAST_MODE_CACHE_DATABASE_URL');
assert(
  ['localhost', '127.0.0.1', '::1'].includes(new URL(cacheUrl).hostname),
  'demo-cache-offload writes rows: refusing a non-local cache database'
);
process.env.SUPABASE_URL = 'http://storage.offload.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offload-test-service-key';
process.env.FAST_CACHE_MEMORY_TTL_MS = '0';
const sslCertFileUnsetAtStart = process.env.SSL_CERT_FILE === undefined;

const objects = new Map<string, Buffer>();
let uploads = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'storage.offload.test') return realFetch(input, init);
  const match = /\/storage\/v1\/object\/(?:authenticated\/)?attachments\/(.+)$/.exec(url.pathname);
  assert(match, `unexpected storage call ${url.pathname}`);
  const path = decodeURIComponent(match[1]);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'POST' || method === 'PUT') {
    uploads += 1;
    const body = init?.body;
    const bytes =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : body instanceof Blob
          ? Buffer.from(await body.arrayBuffer())
          : Buffer.from(String(body ?? ''));
    objects.set(path, bytes);
    return new Response(JSON.stringify({ Key: `attachments/${path}` }), { status: 200 });
  }
  const stored = objects.get(path);
  return stored
    ? new Response(stored, { status: 200 })
    : new Response(
        JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }),
        {
          status: 400,
        }
      );
}) as typeof fetch;

async function main(): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: cacheUrl } } });
  // Importing the store constructs the app client; it must wait for db's first connect.
  const store = await connectThenOpen(db, () => import('../../providers/demoCacheStore'));
  if (process.platform === 'linux' && sslCertFileUnsetAtStart) {
    assert(
      process.env.SSL_CERT_FILE !== undefined,
      'the engine TLS probe must finish before the store constructs its Prisma clients'
    );
  }
  const prefix = `zz-offload-${crypto.randomBytes(4).toString('hex')}-`;
  // Sorts after every key of this run (byte and locale order) without sharing its prefix,
  // like a concurrent run's row on the same database.
  const neighbor = `${prefix.slice(0, -1)}x-d`;
  const big = { status: 200, body_b64: crypto.randomBytes(90_000).toString('base64') };
  const small = { status: 200, body_b64: 'aGVsbG8=' };
  const row = (key: string) =>
    db.$queryRaw<Array<{ value: unknown; xmin: string }>>`
      SELECT value, xmin::text AS xmin FROM "FastModeCacheEntry" WHERE key = ${key}`.then(
      (r) => r[0]
    );
  const isPointer = (value: unknown) =>
    typeof value === 'object' && value !== null && '$fastCacheOffload' in value;
  try {
    // 1. A large browser_http body moves to Storage; the reader gets it back intact.
    const key = `${prefix}a`;
    assert.equal(
      await store.cacheSetWithAck({ key, kind: 'browser_http', goalHash: 'g', value: big }),
      true
    );
    const stored = await row(key);
    assert(
      isPointer(stored.value),
      `row must hold a pointer, got ${JSON.stringify(stored.value).slice(0, 80)}`
    );
    assert.equal(objects.size, 1);
    assert.deepEqual((await store.cacheGet(key)).value, big);

    // 2. An identical re-record does not rewrite the row.
    const before = { xmin: stored.xmin };
    await store.cacheSetWithAck({ key, kind: 'browser_http', goalHash: 'g', value: big });
    assert.equal(
      (await row(key)).xmin,
      before.xmin,
      'identical re-record must not rewrite the row'
    );

    // 3. Small bodies and other kinds (demo/sim LLM rows) stay inline.
    await store.cacheSetWithAck({
      key: `${prefix}b`,
      kind: 'browser_http',
      goalHash: 'g',
      value: small,
    });
    await store.cacheSetWithAck({ key: `${prefix}c`, kind: 'llm', goalHash: 'g', value: big });
    assert.deepEqual((await row(`${prefix}b`)).value, small);
    assert.deepEqual((await row(`${prefix}c`)).value, big);

    // 4. An unreadable body is a miss, never a corrupt hit; re-recording it repairs it.
    objects.clear();
    assert.equal((await store.cacheGet(key)).hit, false);
    await store.cacheSetWithAck({ key, kind: 'browser_http', goalHash: 'g', value: big });
    assert.equal(objects.size, 1, 'an identical re-record must restore a lost body');
    assert.deepEqual((await store.cacheGet(key)).value, big);
    assert.equal(uploads > 0, true);

    // 4b. A cached value that only has the marker shape is never a Storage read.
    const forged = {
      $fastCacheOffload: {
        path: 'some-user/private-upload.pdf',
        sha256: 'f'.repeat(64),
        bytes: 10,
      },
    };
    await store.cacheSetWithAck({ key: `${prefix}e`, kind: 'llm', goalHash: 'g', value: forged });
    assert.deepEqual((await store.cacheGet(`${prefix}e`)).value, forged);

    // 5. Existing inline rows move through the batched backfill; dry run first. The scan
    //    stays inside its key prefix: another run's inline row is never moved.
    const legacy = `${prefix}d`;
    await db.$executeRaw`
      INSERT INTO "FastModeCacheEntry" (key, kind, "goalHash", value)
      VALUES (${legacy}, 'browser_http', 'g', ${JSON.stringify(big)}::jsonb),
             (${neighbor}, 'browser_http', 'g', ${JSON.stringify(big)}::jsonb)`;
    const outside = await row(neighbor);
    const inline = await row(legacy);
    const dry = await store.offloadFastCacheBatch(prefix, 10, { dryRun: true, keyPrefix: prefix });
    assert.equal(dry.offloaded, 1, JSON.stringify(dry));
    assert.equal((await row(legacy)).xmin, inline.xmin, 'a dry run must not write');
    const real = await store.offloadFastCacheBatch(prefix, 10, {
      concurrency: 4,
      keyPrefix: prefix,
    });
    assert.deepEqual(
      real.offloadedRows.map((r) => r.key),
      [legacy],
      'the receipt must list exactly the moved row'
    );
    assert(isPointer((await row(legacy)).value));
    assert(objects.has(real.offloadedRows[0].path), 'the receipt must name the stored object');
    assert.deepEqual((await store.cacheGet(legacy)).value, big);
    assert.equal(
      (await store.offloadFastCacheBatch(prefix, 10, { keyPrefix: prefix })).offloaded,
      0,
      'a rerun is a no-op'
    );
    assert.equal((await row(neighbor)).xmin, outside.xmin, 'a row outside the prefix is untouched');
    process.stdout.write(
      'PASS large browser_http cache values live in Storage behind verified pointers; reads, dedupe and backfill are exact\n'
    );
  } finally {
    await db.$executeRaw`
      DELETE FROM "FastModeCacheEntry" WHERE key LIKE ${`${prefix}%`} OR key = ${neighbor}`;
    await db.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
