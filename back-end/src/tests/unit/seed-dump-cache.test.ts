#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { objectKey } from '../../../scripts/seed-dump-cache';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
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

test('CLI fails closed (exit 1) when R2 is unconfigured — caller cold-syncs', () => {
  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  let code = 0;
  try {
    execFileSync('npx', ['tsx', script, 'get', 'tok', '/tmp/seed-dump-cache-test.out'], {
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
    });
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  assert.equal(code, 1, 'unconfigured get must exit non-zero so run.sh falls back to cold-sync');
});

test('CLI fails closed (exit 1) on a missing subcommand argument', () => {
  const script = path.resolve(__dirname, '../../../scripts/seed-dump-cache.ts');
  let code = 0;
  try {
    execFileSync('npx', ['tsx', script, 'get'], { stdio: 'pipe' });
  } catch (err) {
    code = (err as { status?: number }).status ?? 1;
  }
  assert.equal(code, 1);
});

console.log('seed-dump-cache: all tests passed');
