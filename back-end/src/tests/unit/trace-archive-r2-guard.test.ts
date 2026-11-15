#!/usr/bin/env tsx
/**
 * Dev/test processes never write the production trace archive bucket.
 *
 *   non-production, no opt-in  ─► R2 write/delete refused; servers redirect to local
 *   production | Fly | TRACE_ARCHIVE_ALLOW_NONPROD_R2=1 ─► allowed
 *   every backend test runner pins TRACE_ARCHIVE_BACKEND=local
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { putR2 } from '../../providers/traceArchiveWriteStorage';
import { storeEncryptedArtifact } from '../../providers/traceArchive';
import {
  NonProductionR2WriteError,
  r2ArchiveWritesAllowed,
  redirectNonProductionServerArchiveToLocal,
} from '../../providers/traceArchiveR2Guard';

const GUARD_ENV = [
  'NODE_ENV',
  'ENVIRONMENT',
  'FLY_APP_NAME',
  'FLY_MACHINE_ID',
  'TRACE_ARCHIVE_ALLOW_NONPROD_R2',
  'TRACE_ARCHIVE_BACKEND',
  'TRACE_ARCHIVE_ENABLED',
  'R2_BUCKET_TRACE_ARCHIVE',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

async function withEnv(
  values: Partial<Record<(typeof GUARD_ENV)[number], string>>,
  fn: () => Promise<void> | void
) {
  const saved = Object.fromEntries(GUARD_ENV.map((key) => [key, process.env[key]]));
  for (const key of GUARD_ENV) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await fn();
  } finally {
    for (const key of GUARD_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const r2Config = {
  TRACE_ARCHIVE_ENABLED: '1',
  TRACE_ARCHIVE_BACKEND: 'r2',
  R2_BUCKET_TRACE_ARCHIVE: 'prod-bucket-must-not-be-touched',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

async function main(): Promise<void> {
  await withEnv({ ...r2Config, NODE_ENV: 'test' }, async () => {
    assert.equal(r2ArchiveWritesAllowed(), false);
    await assert.rejects(
      putR2('root-1', 'llm/x.json.gz.enc', Buffer.from('x'), 'application/json'),
      NonProductionR2WriteError
    );
    await assert.rejects(
      storeEncryptedArtifact({
        rootAgentId: 'root-1',
        objectPath: 'llm/x.json.gz.enc',
        ciphertext: Buffer.from('x'),
      }),
      /TRACE_ARCHIVE_ALLOW_NONPROD_R2=1/,
      'refusal is immediate (no retry loop) and documents the opt-in'
    );
    const warnings: string[] = [];
    assert.equal(
      redirectNonProductionServerArchiveToLocal((m) => warnings.push(m)),
      true
    );
    assert.equal(process.env.TRACE_ARCHIVE_BACKEND, 'local');
    assert.equal(warnings.length, 1);
  });
  for (const allowed of [
    { NODE_ENV: 'production' },
    { ENVIRONMENT: 'production' },
    { FLY_APP_NAME: 'navi-whisper-lux' },
    { FLY_MACHINE_ID: '148ed193b95389' },
    { TRACE_ARCHIVE_ALLOW_NONPROD_R2: '1' },
  ]) {
    await withEnv({ ...r2Config, ...allowed }, () => {
      assert.equal(r2ArchiveWritesAllowed(), true, JSON.stringify(allowed));
      assert.equal(
        redirectNonProductionServerArchiveToLocal(() => undefined),
        false
      );
      assert.equal(process.env.TRACE_ARCHIVE_BACKEND, 'r2');
    });
  }

  const bootstrap = readFileSync(join(process.cwd(), 'src', 'bootstrap.ts'), 'utf8');
  assert.match(bootstrap, /redirectNonProductionServerArchiveToLocal\(/);
  const unitRunner = readFileSync(join(process.cwd(), 'scripts', 'run-unit-tests.ts'), 'utf8');
  assert.match(unitRunner, /\.\.\.hermeticArchiveEnv\(process\.env\)/);
  assert.match(unitRunner, /delete childEnv\.TRACE_ARCHIVE_ALLOW_NONPROD_R2/);
  process.stdout.write('trace-archive-r2-guard: all checks passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
