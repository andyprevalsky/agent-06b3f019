#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';

import {
  bulkTransferTimeoutMs,
  cacheRequestTimeoutMs,
  MULTIPART_CHUNK_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  objectKey,
  planUploadParts,
  shouldUseMultipartUpload,
} from '../../../scripts/seed-dump-cache';

/**
 * Resolve the tsx CLI used to spawn the script under test.
 *
 * npm workspaces normally hoist tsx to the REPO ROOT, but a worktree whose root
 * install failed (or that installed `back-end` on its own) only has it under
 * back-end/. Hard-coding the hoisted path made every spawn here run a
 * non-existent file: the child died instantly with MODULE_NOT_FOUND, so the
 * deadline test reported the misleading "never reached the hanging endpoint",
 * and the exit-code test passed VACUOUSLY because a missing module also exits 1.
 * Probe both locations and fail with the real reason when neither exists.
 */
function resolveTsxCli(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../node_modules/tsx/dist/cli.mjs'),
    path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    found !== undefined,
    `tsx CLI not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Run `npm ci` in back-end/ (or at the repo root) before this suite.'
  );
  return found;
}

const tsxCli = resolveTsxCli();

function test(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ❌ ${name}\n`);
    throw error;
  }
}

test('keys a token under the benchmark-seed-dumps prefix with a .dump suffix', () => {
  assert.equal(objectKey('abc123-20260719'), 'benchmark-seed-dumps/abc123-20260719.dump');
});

test('strips path-traversal and unsafe characters (no escaping the prefix)', () => {
  // Slashes, dots-that-form-traversal, and shell metachars are removed, so a
  // hostile token can never write outside benchmark-seed-dumps/.
  assert.equal(objectKey('../../etc/passwd'), 'benchmark-seed-dumps/....etcpasswd.dump');
  assert.equal(objectKey('a b;rm -rf/'), 'benchmark-seed-dumps/abrm-rf.dump');
  for (const key of [objectKey('../../etc/passwd'), objectKey('a/b/c')]) {
    assert.ok(
      !key.slice('benchmark-seed-dumps/'.length).includes('/'),
      `no nested slash in ${key}`
    );
  }
});

test('schema-hash + day token round-trips unchanged', () => {
  const token = 'e3b0c44298fc1c149afbf4c8996fb924-20260719';
  assert.equal(objectKey(token), `benchmark-seed-dumps/${token}.dump`);
});

test('request deadline defaults below the benchmark service readiness window', () => {
  assert.equal(cacheRequestTimeoutMs({}), 30_000);
  assert.equal(cacheRequestTimeoutMs({ SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '250' }), 250);
  assert.ok(cacheRequestTimeoutMs({}) < 180_000);
});

test('bulk transfers get a budget large enough for the ~150MB canonical base', () => {
  // The probe timeout is sized for a miss; a 150MB body needs far more. Sharing
  // one 30s budget is what made a republication die mid-stream.
  assert.ok(bulkTransferTimeoutMs({}) > cacheRequestTimeoutMs({}));
  assert.equal(bulkTransferTimeoutMs({}), 300_000);
  assert.equal(bulkTransferTimeoutMs({ SEED_DUMP_CACHE_BULK_TIMEOUT_MS: '90000' }), 90_000);
  // Clamped both ways so a typo cannot hang a boot forever or disable the budget.
  assert.equal(bulkTransferTimeoutMs({ SEED_DUMP_CACHE_BULK_TIMEOUT_MS: '1' }), 1_000);
  assert.equal(bulkTransferTimeoutMs({ SEED_DUMP_CACHE_BULK_TIMEOUT_MS: '99999999' }), 1_800_000);
  assert.equal(bulkTransferTimeoutMs({ SEED_DUMP_CACHE_BULK_TIMEOUT_MS: 'nonsense' }), 300_000);

  // An explicitly pinned probe deadline must still bound the bulk path, or a
  // hung endpoint stalls a boot for the full bulk budget instead of failing
  // fast (exactly what the hanging-endpoint test below asserts).
  assert.equal(bulkTransferTimeoutMs({ SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '2000' }), 2_000);
  // An explicit bulk budget still wins over the probe pin when both are set.
  assert.equal(
    bulkTransferTimeoutMs({
      SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '2000',
      SEED_DUMP_CACHE_BULK_TIMEOUT_MS: '120000',
    }),
    120_000
  );
});

test('multipart plan covers the whole object with S3-legal part sizes', () => {
  // R2/S3 reject any part below 5MiB except the last one.
  assert.ok(MULTIPART_CHUNK_BYTES >= 5 * 1024 * 1024);
  assert.ok(MULTIPART_THRESHOLD_BYTES >= MULTIPART_CHUNK_BYTES);

  const size = 152_119_674; // the real canonical base artifact
  const parts = planUploadParts(size);

  assert.equal(parts[0].start, 0);
  assert.equal(parts[parts.length - 1].end, size, 'plan must reach exactly EOF');
  assert.deepEqual(
    parts.map((p) => p.partNumber),
    parts.map((_, i) => i + 1),
    'part numbers must be 1-based and contiguous'
  );
  // No gaps and no overlaps: byte N belongs to exactly one part.
  for (let i = 1; i < parts.length; i += 1) {
    assert.equal(parts[i].start, parts[i - 1].end, `gap/overlap before part ${i + 1}`);
  }
  // Every part but the last is exactly one chunk; the last is the remainder.
  for (const part of parts.slice(0, -1)) {
    assert.equal(part.end - part.start, MULTIPART_CHUNK_BYTES);
  }
  const last = parts[parts.length - 1];
  assert.ok(last.end - last.start > 0 && last.end - last.start <= MULTIPART_CHUNK_BYTES);
  assert.equal(
    parts.reduce((sum, p) => sum + (p.end - p.start), 0),
    size,
    'parts must sum to the file size'
  );
});

test('multipart plan handles exact-multiple and tiny sizes without empty parts', () => {
  const exact = planUploadParts(MULTIPART_CHUNK_BYTES * 3);
  assert.equal(exact.length, 3);
  assert.equal(exact[2].end, MULTIPART_CHUNK_BYTES * 3);

  const tiny = planUploadParts(10);
  assert.equal(tiny.length, 1);
  assert.deepEqual(tiny[0], { partNumber: 1, start: 0, end: 10 });

  assert.deepEqual(planUploadParts(0), [], 'an empty object needs no parts');
});

test('compressed canonical base uses retryable multipart upload', () => {
  // Current pg16 custom-format canonical base after the compute schema rebase.
  // Sending this 30.8MB artifact through one PutObject stream reproduced
  // `sslv3 alert bad record mac`; multipart retries only the failed chunk.
  const compressedCanonicalBytes = 30_781_281;
  assert.equal(shouldUseMultipartUpload(compressedCanonicalBytes), true);
  assert.ok(MULTIPART_THRESHOLD_BYTES <= compressedCanonicalBytes);
});

test('CLI fails closed (exit 1) when R2 is unconfigured — caller cold-syncs', () => {
  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  let code = 0;
  try {
    execFileSync(
      process.execPath,
      [tsxCli, script, 'get', 'tok', '/tmp/seed-dump-cache-test.out'],
      {
        // Blank ALL four R2 vars so the script's .env loader can't refill them —
        // makes "unconfigured" deterministic regardless of the local back-end/.env.
        env: {
          ...process.env,
          R2_BUCKET_TRACE_ARCHIVE: '',
          R2_ACCOUNT_ID: '',
          R2_ACCESS_KEY_ID: '',
          R2_SECRET_ACCESS_KEY: '',
        },
        stdio: 'pipe',
      }
    );
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  assert.equal(code, 1, 'unconfigured get must exit non-zero so run.sh falls back to cold-sync');
});

test('CLI fails closed (exit 1) on a missing subcommand argument', () => {
  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  let code = 0;
  try {
    execFileSync(process.execPath, [tsxCli, script, 'get'], { stdio: 'pipe' });
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  assert.equal(code, 1);
});

async function testHangingEndpointIsBounded(): Promise<void> {
  let requestObserved = false;
  let requestWatchdog: NodeJS.Timeout | undefined;
  let killedByRequestWatchdog = false;
  const server = createServer(() => {
    // Intentionally leave the response open: the client deadline must abort it.
    requestObserved = true;
    clearTimeout(startupWatchdog);
    requestWatchdog = setTimeout(() => {
      killedByRequestWatchdog = true;
      child.kill('SIGKILL');
    }, 10_000);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');

  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  const child = spawn(
    process.execPath,
    [tsxCli, script, 'get', 'tok', '/tmp/seed-dump-cache-hang.out'],
    {
      env: {
        ...process.env,
        R2_BUCKET_TRACE_ARCHIVE: 'test-bucket',
        R2_ACCOUNT_ID: 'test-account',
        R2_ACCESS_KEY_ID: 'test-access',
        R2_SECRET_ACCESS_KEY: 'test-secret',
        R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
        // The deploy verifier deliberately saturates the host with backend and
        // agents coverage workers. Leave enough time for the local TCP
        // handshake while keeping the hung response deadline sharply bounded.
        SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '2000',
      },
      stdio: 'pipe',
    }
  );
  const childOutput: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => childOutput.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => childOutput.push(chunk));
  let killedByStartupWatchdog = false;
  const startupWatchdog = setTimeout(() => {
    killedByStartupWatchdog = true;
    child.kill('SIGKILL');
  }, 30_000);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(startupWatchdog);
  if (requestWatchdog) clearTimeout(requestWatchdog);
  server.closeAllConnections();
  server.close();

  const output = Buffer.concat(childOutput).toString('utf8').trim();
  assert.equal(
    killedByStartupWatchdog,
    false,
    `R2 deadline test CLI did not start${output === '' ? '' : `:\n${output}`}`
  );
  assert.equal(
    requestObserved,
    true,
    `R2 deadline test never reached the hanging endpoint${output === '' ? '' : `:\n${output}`}`
  );
  assert.equal(killedByRequestWatchdog, false, 'R2 request exceeded its client-owned deadline');
  assert.equal(code, 1, 'timed-out cache lookup must fail closed');
}

// The sharded --check refuses a missing canonical base from this probe before any
// Machine. A transport failure must stay distinguishable from a definite absence.
async function headExitFor(status: number, contentLength: number): Promise<number | null> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(status, { 'Content-Length': String(contentLength) });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  const child = spawn(process.execPath, [tsxCli, script, 'head', 'tok-head'], {
    env: {
      ...process.env,
      R2_BUCKET_TRACE_ARCHIVE: 'test-bucket',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-access',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
      SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '10000',
    },
    stdio: 'pipe',
  });
  const [code] = (await once(child, 'close')) as [number | null];
  server.closeAllConnections();
  server.close();
  assert.deepEqual(
    requests.filter((line) => !line.endsWith(' /')),
    ['HEAD /test-bucket/benchmark-seed-dumps/tok-head.dump'],
    'head reads only the object metadata, never the body'
  );
  return code;
}

async function testHeadDistinguishesAbsentFromUnreadable(): Promise<void> {
  assert.equal(await headExitFor(200, 4096), 0, 'a present object reports exit 0');
  assert.equal(await headExitFor(404, 0), 3, 'a definite absence reports exit 3');
  assert.equal(await headExitFor(200, 0), 3, 'an empty object is as unusable as a missing one');
  assert.equal(await headExitFor(500, 0), 1, 'an unreadable cache is not reported as a miss');
}

testHangingEndpointIsBounded()
  .then(() => process.stdout.write('  ✅ hanging R2 endpoint respects request deadline\n'))
  .then(() => testHeadDistinguishesAbsentFromUnreadable())
  .then(() => process.stdout.write('  ✅ head separates present, absent and unreadable objects\n'))
  .then(() => process.stdout.write('seed-dump-cache: all tests passed\n'))
  .catch((error: unknown) => {
    process.stderr.write(`  ❌ seed-dump-cache async controls\n${String(error)}\n`);
    process.exit(1);
  });
