#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const tsxCli = require.resolve('tsx/cli');
const SEEDED_AGENT_ID = 'b0b0b0b0-0000-4000-8000-000000000001';
const LOCAL_DB_URL =
  process.env.BLACKBOX_TEST_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  'postgresql://postgres:postgres@localhost:5432/victoria?schema=public';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runSeed(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const backendRoot = resolve(__dirname, '../../..');
  const result = spawnSync(process.execPath, [tsxCli, 'scripts/seed-browser-agent.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      ...env,
      // The gate must use its lockfile-owned executable, not ambient PATH or a
      // floating package runner that can stall/download under host load.
      PATH: '',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${
      result.error ? `\n${String(result.error)}` : ''
    }`,
  };
}

function testRejectsLookalikeLocalhostBeforeDatabaseAccess(): void {
  const databaseUrl =
    'postgresql://postgres:postgres@localhost.attacker.invalid:5432/victoria?connect_timeout=1';
  const { status, output } = runSeed({
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
  });

  assert(status !== 0, 'expected the non-local seed attempt to fail');
  assert(
    output.includes(
      'Refusing to seed: DATABASE_URL host is "localhost.attacker.invalid", not local.'
    ),
    `expected the local-only guard to reject the exact parsed hostname before Prisma access:\n${output}`
  );
  assert(!output.includes('PrismaClient'), `expected no Prisma connection attempt:\n${output}`);
}

async function testSeedsActiveBrowserAgentAgainstLocalDatabase(): Promise<void> {
  const host = new URL(LOCAL_DB_URL).hostname.toLowerCase();
  assert(
    host === 'localhost' || host === '127.0.0.1',
    `seed-browser-agent happy-path requires local Postgres, got ${host}`
  );

  const { status, output } = runSeed({
    DATABASE_URL: LOCAL_DB_URL,
    DIRECT_URL: LOCAL_DB_URL,
    BROWSER_TASK_ID: 'browser-task-seed-bb',
    BROWSER_URL: 'https://example.com/seed-browser-agent-blackbox',
  });
  assert(status === 0, `expected local seed to succeed:\n${output}`);
  assert(
    output.includes(SEEDED_AGENT_ID),
    `expected seed stdout to mention the fixed agent id:\n${output}`
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });
  try {
    const agent = await prisma.agent.findUnique({ where: { id: SEEDED_AGENT_ID } });
    assert(agent, 'expected the seeded browser agent row');
    assert(agent.status === 'ACTIVE', `expected ACTIVE agent, got ${agent.status}`);
    assert(
      (agent.messageCount ?? 0) > 5,
      `expected a multi-step browser trajectory, got messageCount=${agent.messageCount}`
    );
    const browserMessages = await prisma.message.count({
      where: {
        agentId: SEEDED_AGENT_ID,
        metadata: {
          path: ['toolName'],
          equals: 'spawn_browser_agent',
        },
      },
    });
    assert(
      browserMessages > 0,
      'expected spawn_browser_agent tool messages on the seeded trajectory'
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  testRejectsLookalikeLocalhostBeforeDatabaseAccess();
  process.stdout.write('PASS seed browser agent rejects lookalike localhost\n');
  await testSeedsActiveBrowserAgentAgainstLocalDatabase();
  process.stdout.write('PASS seed browser agent seeds active browser trajectory locally\n');
}

main().catch((error) => {
  process.stderr.write('FAIL seed-browser-agent blackbox\n');
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
