#!/usr/bin/env tsx
/**
 * Blackbox: IndexedDB machine-upload ingest must not decode blob origins through
 * V8's JSON codec.
 *
 * RCA cement (prod 2026-08-12). Render backend crash-looped every ~5 minutes with
 * `FATAL ERROR: Zone Allocation failed - process out of memory` (exit 134), taking
 * login with it (every `/health` and `/api/auth/*` returned 502 while the instance
 * was down). The last application log before each OOM was
 * `Received IndexedDB origins` for user `1f85ff25-…` after an `/indexedDB/upload`
 * request that had already spent ~80s decrypting/decompressing while localStorage
 * batches and the Plaid cron ran in parallel. Prod's largest IndexedDB row is an
 * 8.7MB `https://drive.google.com` blob — the same shape that previously OOM'd
 * the seed path when Prisma decoded it (see `seed-blob-origin-memory`).
 *
 * Pre-fix production path:
 *   gunzip → JSON.parse(full payload) → JSON.stringify(databases) → $executeRaw
 * Peak heap scales with the parsed object graph (10-50× the JSON bytes), not the
 * byte size.
 *
 * This suite pins the contract with a two-child experiment on one fixture:
 *   control  — JSON.parse(payload) under {@link CHILD_HEAP_MB}MB must OOM
 *   treatment — ingestIndexedDBUploadJson(payload) under the same heap must live
 *              and round-trip databases by server-side md5
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabase } from './assertLocalDatabase';
import { ingestIndexedDBUploadJson } from '../../domains/integrations/uploadService';

assertLocalDatabase();

const USER_ID = 'idb-upload-memory-user';
const BIG_ORIGIN = 'https://drive.google.com';
const SMALL_ORIGIN = 'https://idb-upload-small.test';
/** ~50MB nested JSON — matches seed-blob-origin-memory density. */
const BLOB_RECORDS = 360_000;
/**
 * Room for one decompressed upload string + Prisma engine (measured green for
 * the set-based path), but not for the pre-fix object-graph copies.
 */
const CHILD_HEAP_MB = 256;
const MIN_PAYLOAD_CHARS = 40_000_000;

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const payloadPath =
  process.env.IDB_UPLOAD_MEMORY_PAYLOAD_PATH ??
  path.join(os.tmpdir(), 'idb-upload-memory-payload.json');

async function runChildIngest(): Promise<void> {
  let peakRssMb = 0;
  const sampler = setInterval(() => {
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1024 / 1024);
  }, 25);

  try {
    const jsonString = fs.readFileSync(payloadPath, 'utf8');
    const result = await ingestIndexedDBUploadJson(USER_ID, jsonString);
    clearInterval(sampler);
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1024 / 1024);
    process.stdout.write(
      `child: upserted ${result.originCount} origin(s); peak rss ${peakRssMb.toFixed(0)}MB ` +
        `(heap cap ${CHILD_HEAP_MB}MB; payload ${jsonString.length} chars)\n`
    );
  } finally {
    clearInterval(sampler);
  }
}

function runChildJsonParseControl(): void {
  const jsonString = fs.readFileSync(payloadPath, 'utf8');
  // Pre-fix ingest retained the parsed envelope AND a re-stringified
  // databases copy per origin (Prisma query-protocol bind). Concurrent
  // localStorage batches in prod multiplied residency further; here we keep
  // several parsed graphs + stringified databases so the same heap budget
  // that the fixed path survives is fatal for the codec path.
  const graphs: Array<{ origins: Array<{ origin: string; databases: unknown }> }> = [];
  const encoded: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const parsed = JSON.parse(jsonString) as {
      origins: Array<{ origin: string; databases: unknown }>;
    };
    graphs.push(parsed);
    for (const origin of parsed.origins) {
      const databasesJson = JSON.stringify(origin.databases);
      encoded.push(JSON.stringify([USER_ID, origin.origin, databasesJson, `hash-${i}`]));
    }
  }
  process.stdout.write(
    `control: graphs=${graphs.length} encoded=${encoded.length} chars=${encoded.reduce((n, s) => n + s.length, 0)}\n`
  );
}

const prisma = new PrismaClient();

async function buildPayloadFile(): Promise<number> {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS idb_upload_memory_fixture`);
  await prisma.$executeRawUnsafe(`
    CREATE TEMP TABLE idb_upload_memory_fixture AS
    SELECT jsonb_build_object(
      'batchIndex', 0,
      'totalBatches', 1,
      'hashes', jsonb_build_object(
        ${sqlString(BIG_ORIGIN)}, 'big-hash',
        ${sqlString(SMALL_ORIGIN)}, 'small-hash'
      ),
      'origins', jsonb_build_array(
        jsonb_build_object(
          'origin', ${sqlString(BIG_ORIGIN)},
          'databases', jsonb_build_array(jsonb_build_object(
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
          ))
        ),
        jsonb_build_object(
          'origin', ${sqlString(SMALL_ORIGIN)},
          'databases', '[{"name":"tiny","objectStores":[]}]'::jsonb
        )
      )
    ) AS doc`);

  const rows = await prisma.$queryRawUnsafe<Array<{ chars: number; doc: string }>>(
    `SELECT length(doc::text)::int AS chars, doc::text AS doc FROM idb_upload_memory_fixture`
  );
  const chars = Number(rows[0]?.chars ?? 0);
  fs.writeFileSync(payloadPath, rows[0]?.doc ?? '');
  return chars;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function cleanupUser(): Promise<void> {
  await prisma.indexedDBOrigin.deleteMany({ where: { userId: USER_ID } });
}

type ChildResult = { code: number | null; stdout: string; stderr: string };

async function runChildProcess(mode: '--child' | '--control'): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_HEAP_MB}`,
        '--import',
        'tsx',
        new URL(import.meta.url).pathname,
        mode,
      ],
      {
        env: { ...process.env, IDB_UPLOAD_MEMORY_PAYLOAD_PATH: payloadPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

let control: ChildResult = { code: null, stdout: '', stderr: '' };
let treatment: ChildResult = { code: null, stdout: '', stderr: '' };
let payloadChars = 0;

test(`control JSON.parse OOMs under a ${CHILD_HEAP_MB}MB heap`, async () => {
  const oom =
    control.code !== 0 &&
    /heap out of memory|Zone Allocation failed|FATAL ERROR/i.test(control.stderr);
  assert(
    oom,
    `control JSON.parse must OOM under ${CHILD_HEAP_MB}MB — otherwise the fixture is too small ` +
      `to prove the prod failure mode.\nexit=${control.code}\n--- stderr ---\n` +
      `${control.stderr.split('\n').slice(-20).join('\n')}`
  );
});

test(`treatment ingest survives the same ${CHILD_HEAP_MB}MB heap`, async () => {
  assert(
    treatment.code === 0,
    `ingest must survive a ${CHILD_HEAP_MB}MB heap — child exited ${treatment.code}.\n` +
      `--- stdout ---\n${treatment.stdout}\n--- stderr (tail) ---\n` +
      `${treatment.stderr.split('\n').slice(-30).join('\n')}`
  );
});

// `batchIndex`/`totalBatches` are validated with `^-?[0-9]+$`, which admits
// values wider than a PG int. Those fail the `::int` cast with an out-of-range
// error (not a syntax error), and must still surface as a malformed-payload
// error rather than escaping as a raw database fault.
for (const [label, overflowValue] of [
  ['above', '2147483648'],
  ['below', '-2147483649'],
] as const) {
  test(`batchIndex ${label} the PG int range is a payload error, not a DB error`, async () => {
    const document = JSON.stringify({
      batchIndex: overflowValue,
      totalBatches: 1,
      origins: [{ origin: SMALL_ORIGIN, databases: {} }],
      hashes: {},
    });

    let caught: unknown;
    try {
      await ingestIndexedDBUploadJson(USER_ID, document);
    } catch (err: unknown) {
      caught = err;
    }

    assert(caught !== undefined, `expected an error for batchIndex=${overflowValue}`);
    assert(
      caught instanceof Error && caught.constructor.name === 'IndexedDBUploadPayloadInvalidError',
      `expected IndexedDBUploadPayloadInvalidError for batchIndex=${overflowValue}, got ` +
        `${caught instanceof Error ? `${caught.constructor.name}: ${caught.message}` : String(caught)}`
    );
  });
}

// A payload may repeat the same origin. `DISTINCT ON (origin)` keeps an
// arbitrary row unless ORDER BY breaks the tie, so the retained `databases`
// would otherwise be non-deterministic. The policy is explicit last-wins.
test('duplicate origins in one payload deterministically keep the last occurrence', async () => {
  const duplicateOrigin = 'https://duplicate.example';
  const document = JSON.stringify({
    batchIndex: 0,
    totalBatches: 1,
    origins: [
      { origin: duplicateOrigin, databases: { pick: 'first' } },
      { origin: duplicateOrigin, databases: { pick: 'second' } },
      { origin: duplicateOrigin, databases: { pick: 'last' } },
    ],
    hashes: {},
  });

  const result = await ingestIndexedDBUploadJson(USER_ID, document);
  assert(
    result.originCount === 1,
    `duplicate origins must collapse to one row, got ${result.originCount}`
  );

  const rows = await prisma.$queryRawUnsafe<Array<{ pick: string }>>(
    `SELECT databases->>'pick' AS pick
     FROM "IndexedDBOrigin"
     WHERE "userId" = $1 AND origin = $2`,
    USER_ID,
    duplicateOrigin
  );
  assert(rows.length === 1, `expected exactly one stored row, got ${rows.length}`);
  assert(rows[0].pick === 'last', `expected the last occurrence to win, got "${rows[0].pick}"`);

  await prisma.$executeRawUnsafe(
    `DELETE FROM "IndexedDBOrigin" WHERE "userId" = $1 AND origin = $2`,
    USER_ID,
    duplicateOrigin
  );
});

test('both origins land and the large blob round-trips by md5', async () => {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ origin: string; digest: string; chars: number }>
  >(
    `SELECT origin,
            md5(databases::text) || ':' || length(databases::text)::text AS digest,
            length(databases::text)::int AS chars
     FROM "IndexedDBOrigin"
     WHERE "userId" = $1
     ORDER BY origin`,
    USER_ID
  );
  assert(rows.length === 2, `expected 2 origins upserted, got ${rows.length}`);
  const big = rows.find((row) => row.origin === BIG_ORIGIN);
  assert(big !== undefined, `missing ${BIG_ORIGIN}`);
  assert(
    Number(big.chars) > 4_000_000,
    `stored big origin must remain large; got ${big.chars} chars`
  );

  const fileText = fs.readFileSync(payloadPath, 'utf8');
  const expected = await prisma.$queryRawUnsafe<Array<{ digest: string }>>(
    `SELECT md5((($1::jsonb)->'origins'->0->'databases')::text) || ':' ||
            length((($1::jsonb)->'origins'->0->'databases')::text)::text AS digest`,
    fileText
  );
  assert(
    expected[0]?.digest === big.digest,
    `big origin databases must round-trip byte-identically: stored ${big.digest}, source ${expected[0]?.digest}`
  );
});

async function main(): Promise<void> {
  if (process.argv.includes('--child')) {
    await runChildIngest();
    return;
  }
  if (process.argv.includes('--control')) {
    runChildJsonParseControl();
    return;
  }

  let failed = 0;
  try {
    await cleanupUser();
    payloadChars = await buildPayloadFile();
    assert(payloadChars >= MIN_PAYLOAD_CHARS, `fixture payload too small: ${payloadChars} chars`);
    console.log(`fixture payload: ${(payloadChars / 1024 / 1024).toFixed(1)}MB at ${payloadPath}`);

    // Run control first so a broken fixture fails before we claim the fix works.
    control = await runChildProcess('--control');
    treatment = await runChildProcess('--child');

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
    await cleanupUser();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS idb_upload_memory_fixture`);
    await prisma.$disconnect();
    try {
      fs.unlinkSync(payloadPath);
    } catch {
      // ignore
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
