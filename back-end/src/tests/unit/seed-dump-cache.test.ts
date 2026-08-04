#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';

import { cacheRequestTimeoutMs, get, objectKey } from '../../../scripts/seed-dump-cache';

const tsxCli = require.resolve('tsx/cli');

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
  const server = createServer(() => {
    // Intentionally leave the response open: the client deadline must abort it.
    requestObserved = true;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');

  const ownedEnv = [
    'R2_BUCKET_TRACE_ARCHIVE',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS',
  ] as const;
  const previousEnv = new Map(ownedEnv.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_BUCKET_TRACE_ARCHIVE: 'test-bucket',
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
    SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS: '250',
  });

  let harnessDeadlineFired = false;
  let requestFailed = false;
  let harnessTimer: NodeJS.Timeout | undefined;
  const harnessDeadline = new Promise<never>((_, reject) => {
    harnessTimer = setTimeout(() => {
      harnessDeadlineFired = true;
      reject(new Error('R2 request exceeded the harness deadline'));
    }, 2_000);
    harnessTimer.unref();
  });
  try {
    await Promise.race([
      get('tok', `/tmp/seed-dump-cache-hang-${process.pid}.out`),
      harnessDeadline,
    ]);
  } catch {
    requestFailed = true;
  } finally {
    if (harnessTimer !== undefined) clearTimeout(harnessTimer);
    for (const key of ownedEnv) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(requestObserved, true, 'R2 deadline test never reached the hanging endpoint');
  assert.equal(harnessDeadlineFired, false, 'R2 request exceeded its client-owned deadline');
  assert.equal(requestFailed, true, 'timed-out cache lookup must fail closed');
}

testHangingEndpointIsBounded()
  .then(() => process.stdout.write('  ✅ hanging R2 endpoint respects request deadline\n'))
  .then(() => process.stdout.write('seed-dump-cache: all tests passed\n'))
  .catch((error: unknown) => {
    process.stderr.write(`  ❌ hanging R2 endpoint respects request deadline\n${String(error)}\n`);
    process.exit(1);
  });
