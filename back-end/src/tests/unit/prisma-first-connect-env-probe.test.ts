/**
 * The Prisma engine setenv()s SSL_CERT_FILE/DIR once, on an engine thread, during the first connect.
 * glibc reallocates environ for a new variable, so a second client reading process.env during that
 * connect segfaults with no output. Multi-client unit files therefore connect one client first;
 * these checks pin the two facts that ordering relies on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('prisma first connect env probe');

function unitSource(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'tests', 'unit', file), 'utf8');
}

async function main() {
  await test('the engine has finished its environment write when $connect resolves', async () => {
    // Only Linux engines use openssl-probe; macOS builds use the system trust store.
    if (process.platform !== 'linux') return;
    assert.equal(nonLocalDatabaseReason(process.env.DATABASE_URL), null);
    delete process.env.SSL_CERT_FILE;
    delete process.env.SSL_CERT_DIR;
    const client = new PrismaClient();
    try {
      await client.$connect();
      assert.ok(process.env.SSL_CERT_FILE, 'first connect must have set SSL_CERT_FILE');
      assert.ok(process.env.SSL_CERT_DIR, 'first connect must have set SSL_CERT_DIR');
    } finally {
      await client.$disconnect();
    }
  });

  await test('multi-client unit files connect one client before creating the next', () => {
    const ordered: [string, RegExp][] = [
      [
        'workflow-queue-admission-postgres.test.ts',
        /new PrismaClient[\s\S]*await db\.\$connect\(\);[\s\S]*await import\('\.\.\/\.\.\/providers\/workflowQueueAdmission'\)/,
      ],
      [
        'worker-process-recovery-postgres.test.ts',
        /new PrismaClient[\s\S]*await db\.\$connect\(\);\s*const \{ prisma \} = await import\('\.\.\/\.\.\/providers\/database'\)/,
      ],
      [
        'managed-workflow-producers-postgres.test.ts',
        /await prisma\.\$connect\(\);\s*const db = new PrismaClient/,
      ],
      [
        'unit-runner-database-isolation.test.ts',
        /const holder = new PrismaClient[^\n]*\n[^\n]*\n\s*await holder\.\$connect\(\);\s*const sameDatabase = new PrismaClient/,
      ],
    ];
    for (const [file, pattern] of ordered) assert.match(unitSource(file), pattern, file);
  });

  finish();
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
