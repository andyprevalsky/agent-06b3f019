#!/usr/bin/env tsx
/**
 * Pins nonLocalDatabaseReason — the shared "is this DATABASE_URL local?"
 * predicate used by unit-test / checkpoint runners to refuse prod writes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  nonLocalDatabaseReason,
  testEntrypointDatabaseRefusal,
} from '../../utils/localDatabaseUrl';

function test(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ❌ ${name}\n`);
    throw error;
  }
}

test('refuses an unset DATABASE_URL', () => {
  assert.equal(nonLocalDatabaseReason(undefined), 'DATABASE_URL is not set');
  assert.equal(nonLocalDatabaseReason(''), 'DATABASE_URL is not set');
});

test('accepts localhost / 127.0.0.1 / [::1]', () => {
  // Synthetic URLs — must not reuse real .env DATABASE_URL values (secret scanner).
  assert.equal(nonLocalDatabaseReason('postgresql://unit:test@localhost:5432/unitdb'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://unit@127.0.0.1:5432/unitdb'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://unit@[::1]:5432/unitdb'), null);
});

test('refuses a remote host', () => {
  const reason = nonLocalDatabaseReason('postgresql://unit:test@db.example.test:5432/unitdb');
  assert.equal(reason, 'database host "db.example.test" is not local');
});

test('refuses an unparseable URL', () => {
  const reason = nonLocalDatabaseReason('not-a-url');
  assert.equal(reason, 'DATABASE_URL is not a parseable URL');
});

const REMOTE = 'postgresql://unit:test@db.example.test:5432/unitdb';
const LOCAL = 'postgresql://unit:test@localhost:5432/unitdb';
const TEST_FILE = '/repo/back-end/src/tests/blackbox/rose.blackbox.ts';

test('a test file run directly against a remote or unset database is refused', () => {
  const remote = testEntrypointDatabaseRefusal(TEST_FILE, REMOTE, undefined);
  assert.match(remote ?? '', /^Refusing a database query from test file rose\.blackbox\.ts: /);
  assert.match(remote ?? '', /database host "db\.example\.test" is not local/);
  assert.match(testEntrypointDatabaseRefusal(TEST_FILE, undefined, undefined) ?? '', /not set/);
  assert.ok(!(remote ?? '').includes('unit:test'), 'never echoes credentials');
});

test('a local database, a non-test entrypoint and the explicit override are allowed', () => {
  assert.equal(testEntrypointDatabaseRefusal(TEST_FILE, LOCAL, undefined), null);
  assert.equal(
    testEntrypointDatabaseRefusal('/repo/back-end/src/bootstrap.ts', REMOTE, undefined),
    null
  );
  assert.equal(
    testEntrypointDatabaseRefusal('/repo/back-end/scripts/query-db.ts', REMOTE, undefined),
    null
  );
  assert.equal(testEntrypointDatabaseRefusal(undefined, REMOTE, undefined), null);
  assert.equal(testEntrypointDatabaseRefusal(TEST_FILE, REMOTE, '1'), null);
});

test('the backend Prisma client refuses queries from a directly run test file', () => {
  const backendDir = resolve(__dirname, '../../..');
  const root = mkdtempSync(join(tmpdir(), 'test-entrypoint-db-'));
  try {
    const dir = join(root, 'src', 'tests');
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, 'probe.ts');
    const database = JSON.stringify(join(backendDir, 'src/providers/database'));
    writeFileSync(
      probe,
      `import { prisma } from ${database};\n` +
        'void (async () => {\n' +
        '  const attempts = [() => prisma.integration.findFirst(), () => prisma.$queryRawUnsafe("SELECT 1")];\n' +
        '  for (const attempt of attempts) {\n' +
        '    try { await attempt(); console.log("QUERY-RAN"); }\n' +
        '    catch (error) { console.log("REFUSED:" + (error as Error).message); }\n' +
        '  }\n' +
        '  await prisma.$disconnect();\n' +
        '})();\n'
    );
    const env = { ...process.env, DATABASE_URL: REMOTE, DIRECT_URL: REMOTE };
    delete env.BACKEND_UNIT_ALLOW_REMOTE_DB;
    const run = spawnSync(process.execPath, ['--import', 'tsx', probe], {
      cwd: backendDir,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout
      .split('\n')
      .filter((line) => line.startsWith('REFUSED:') || line === 'QUERY-RAN');
    assert.equal(lines.length, 2, run.stdout);
    for (const line of lines) {
      assert.match(
        line,
        /^REFUSED:Refusing a database query from test file probe\.ts: database host "db\.example\.test" is not local/
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write('local-database-url: all tests passed\n');
