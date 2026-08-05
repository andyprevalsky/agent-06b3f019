#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tsxCli = require.resolve('tsx/cli');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testRejectsLookalikeLocalhostBeforeDatabaseAccess(): void {
  const backendRoot = resolve(__dirname, '../../..');
  const databaseUrl =
    'postgresql://postgres:postgres@localhost.attacker.invalid:5432/victoria?connect_timeout=1';
  const result = spawnSync(process.execPath, [tsxCli, 'scripts/seed-browser-agent.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      // The gate must use its lockfile-owned executable, not ambient PATH or a
      // floating package runner that can stall/download under host load.
      PATH: '',
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  assert(
    result.error === undefined,
    `expected the seed CLI to start hermetically: ${result.error}`
  );
  assert(result.status !== 0, 'expected the non-local seed attempt to fail');
  assert(
    output.includes(
      'Refusing to seed: DATABASE_URL host is "localhost.attacker.invalid", not local.'
    ),
    `expected the local-only guard to reject the exact parsed hostname before Prisma access:\n${output}`
  );
  assert(!output.includes('PrismaClient'), `expected no Prisma connection attempt:\n${output}`);
}

try {
  testRejectsLookalikeLocalhostBeforeDatabaseAccess();
  process.stdout.write('PASS seed browser agent rejects lookalike localhost\n');
} catch (error) {
  process.stderr.write('FAIL seed browser agent rejects lookalike localhost\n');
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
