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

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabase } from './assertLocalDatabase';
import {
  BLOB_FIXTURE_BACKEND_PEAK_MB,
  blobOriginDatabasesSql,
  measureBackendPeak,
} from './blob-origin-fixture.helpers';
import { ingestIndexedDBUploadJson } from '../../domains/integrations/uploadService';
import {
  formatUploadChildFailure,
  type UploadChildResult,
} from './indexeddb-upload-memory.diagnostics';

assertLocalDatabase();

const isChildMode = process.argv.includes('--child') || process.argv.includes('--control');
const USER_ID =
  (isChildMode ? process.env.IDB_UPLOAD_MEMORY_USER_ID : undefined) ??
  `idb-upload-memory-${randomUUID()}`;
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

const payloadFixture = (() => {
  const inheritedPath = isChildMode ? process.env.IDB_UPLOAD_MEMORY_PAYLOAD_PATH : undefined;
  if (inheritedPath !== undefined) return { payloadPath: inheritedPath, ownedDirectory: null };
  const ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'idb-upload-memory-'));
  return { payloadPath: path.join(ownedDirectory, 'payload.json'), ownedDirectory };
})();
const { payloadPath, ownedDirectory: ownedPayloadDirectory } = payloadFixture;

test('payload fixture path belongs to one run', async () => {
  const env = {
    ...process.env,
    IDB_UPLOAD_MEMORY_PAYLOAD_PATH: path.join(os.tmpdir(), 'shared-idb-payload.json'),
  };
  const childPath = () =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', new URL(import.meta.url).pathname, '--print-payload-path'],
      { env, encoding: 'utf8' }
    ).trim();
  const first = childPath();
  const second = childPath();
  assert(
    first !== second && first !== payloadPath && second !== payloadPath,
    `independent runs shared the payload fixture: parent=${payloadPath} children=${first},${second}`
  );
});

test('database fixture user ID belongs to one run', async () => {
  const env = { ...process.env, IDB_UPLOAD_MEMORY_USER_ID: 'shared-idb-user' };
  const childUserId = () =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', new URL(import.meta.url).pathname, '--print-user-id'],
      { env, encoding: 'utf8' }
    ).trim();
  const first = childUserId();
  const second = childUserId();
  assert(
    first !== second && first !== USER_ID && second !== USER_ID,
    `independent runs shared the database fixture user: parent=${USER_ID} children=${first},${second}`
  );
});

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

/** jsonb's canonical rendering around the big origin's `databases` value. */
const PAYLOAD_PREFIX =
  `{"hashes": {${JSON.stringify(BIG_ORIGIN)}: "big-hash", ${JSON.stringify(SMALL_ORIGIN)}: ` +
  `"small-hash"}, "origins": [{"origin": ${JSON.stringify(BIG_ORIGIN)}, "databases": `;
const PAYLOAD_SUFFIX =
  `}, {"origin": ${JSON.stringify(SMALL_ORIGIN)}, "databases": [{"name": "tiny", ` +
  `"objectStores": []}]}], "batchIndex": 0, "totalBatches": 1}`;

/** Upload document plus `md5:length` of the big origin's `databases` text. */
function payloadSql(records: number): string {
  return `WITH blob AS MATERIALIZED (${blobOriginDatabasesSql(records)})
    SELECT $1::text || databases || $2::text AS doc,
           md5(databases) || ':' || length(databases)::text AS databases_digest
    FROM blob`;
}

let fixtureBackendPeakMb = 0;
let bigDatabasesDigest = '';

async function buildPayloadFile(): Promise<number> {
  const { result: rows, backendPeakMb } = await measureBackendPeak((client) =>
    client.$queryRawUnsafe<Array<{ doc: string; databases_digest: string }>>(
      payloadSql(BLOB_RECORDS),
      PAYLOAD_PREFIX,
      PAYLOAD_SUFFIX
    )
  );
  fixtureBackendPeakMb = backendPeakMb;
  bigDatabasesDigest = rows[0]?.databases_digest ?? '';
  const doc = rows[0]?.doc ?? '';
  fs.writeFileSync(payloadPath, doc);
  return doc.length;
}

async function cleanupUser(): Promise<void> {
  await prisma.indexedDBOrigin.deleteMany({ where: { userId: USER_ID } });
}

type ChildResult = UploadChildResult;

async function runChildProcess(mode: '--child' | '--control'): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    const startedAtMs = Date.now();
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
        env: {
          ...process.env,
          IDB_UPLOAD_MEMORY_PAYLOAD_PATH: payloadPath,
          IDB_UPLOAD_MEMORY_USER_ID: USER_ID,
        },
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
      resolvePromise({ code, stdout, stderr, startedAtMs, finishedAtMs: Date.now() });
    });
  });
}

let control: ChildResult = { code: null, stdout: '', stderr: '', startedAtMs: 0, finishedAtMs: 0 };
let treatment: ChildResult = {
  code: null,
  stdout: '',
  stderr: '',
  startedAtMs: 0,
  finishedAtMs: 0,
};
let payloadChars = 0;

test(`building the fixture keeps one Postgres backend under ${BLOB_FIXTURE_BACKEND_PEAK_MB}MB`, async () => {
  assert(
    fixtureBackendPeakMb > 0 && fixtureBackendPeakMb <= BLOB_FIXTURE_BACKEND_PEAK_MB,
    `building the ${(payloadChars / 1024 / 1024).toFixed(0)}MB fixture peaked the Postgres ` +
      `backend at ${fixtureBackendPeakMb}MB (budget ${BLOB_FIXTURE_BACKEND_PEAK_MB}MB). Build it ` +
      'as text: nested jsonb_build_* levels each keep a full copy of the blob.'
  );
});

test('the fixture is jsonb canonical text, so the stored blob must equal it byte for byte', async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ canonical: boolean }>>(
    `SELECT doc = doc::jsonb::text AS canonical FROM (${payloadSql(3)}) fixture`,
    PAYLOAD_PREFIX,
    PAYLOAD_SUFFIX
  );
  assert(rows[0]?.canonical === true, 'fixture text must equal its own jsonb rendering');
});

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
  assert(treatment.code === 0, formatUploadChildFailure(treatment, CHILD_HEAP_MB));
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
  assert(
    bigDatabasesDigest !== '' && big.digest === bigDatabasesDigest,
    `big origin databases must round-trip byte-identically: stored ${big.digest}, source ${bigDatabasesDigest}`
  );
});

async function main(): Promise<void> {
  if (process.argv.includes('--print-payload-path') || process.argv.includes('--print-user-id')) {
    process.stdout.write(`${process.argv.includes('--print-user-id') ? USER_ID : payloadPath}\n`);
    await prisma.$disconnect();
    if (ownedPayloadDirectory !== null) {
      fs.rmSync(ownedPayloadDirectory, { recursive: true, force: true });
    }
    return;
  }
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
    process.stdout.write(
      `fixture payload: ${(payloadChars / 1024 / 1024).toFixed(1)}MB at ${payloadPath} ` +
        `(Postgres backend peak ${fixtureBackendPeakMb}MB)\n`
    );

    // Run control first so a broken fixture fails before we claim the fix works.
    control = await runChildProcess('--control');
    treatment = await runChildProcess('--child');

    for (const { name, fn } of tests) {
      try {
        await fn();
        process.stdout.write(`✅ ${name}\n`);
      } catch (err) {
        failed += 1;
        process.stderr.write(`❌ ${name}\n   ${(err as Error).message}\n`);
      }
    }
  } finally {
    try {
      await cleanupUser();
    } finally {
      try {
        await prisma.$disconnect();
      } finally {
        if (ownedPayloadDirectory !== null) {
          fs.rmSync(ownedPayloadDirectory, { recursive: true, force: true });
        }
      }
    }
  }

  process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
  if (failed > 0) {
    throw new Error(`${failed}/${tests.length} indexeddb-upload-memory case(s) failed`);
  }
}

void main();
