/**
 * The Prisma engine setenv()s SSL_CERT_FILE/DIR once, on an engine thread, during the first connect.
 * glibc reallocates environ for a new variable, so a second client reading process.env during that
 * connect segfaults with no output. Multi-client unit files therefore connect one client first;
 * these checks pin the two facts that ordering relies on.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('prisma first connect env probe');

const unitDir = join(process.cwd(), 'src', 'tests', 'unit');

function unitSource(file: string): string {
  return readFileSync(join(unitDir, file), 'utf8');
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

  await test('multi-client unit files finish one connect before any other client starts', () => {
    // [file, the first connect, the earliest code that can start another client]
    const ordered: [string, string, string][] = [
      [
        'managed-workflow-producers-postgres.test.ts',
        'await prisma.$connect();',
        'new PrismaClient',
      ],
      [
        'unit-runner-database-isolation.test.ts',
        'await holder.$connect();',
        'const sameDatabase = new PrismaClient',
      ],
      [
        'worker-deployment-queue.test.ts',
        'await admin.$executeRawUnsafe(',
        "await import('../../providers/",
      ],
      [
        'worker-process-recovery-postgres.test.ts',
        'await db.$connect();',
        "await import('../../providers/",
      ],
      [
        'workflow-queue-admission-postgres.test.ts',
        'await db.$connect();',
        "await import('../../providers/",
      ],
    ];
    for (const [file, connect, nextClient] of ordered) {
      const source = unitSource(file);
      const connectAt = source.indexOf(connect);
      assert.ok(connectAt >= 0, `${file}: first connect not found`);
      assert.ok(connectAt < source.indexOf(nextClient), `${file}: connect must come first`);
      assert.ok(
        source.slice(0, connectAt).split('new PrismaClient').length <= 2,
        `${file}: only one client may exist before the first connect`
      );
    }
    const clientFiles = (readdirSync(unitDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.test.ts') && file !== basename(__filename))
      .filter((file) => unitSource(file).includes('new PrismaClient'))
      .sort();
    assert.deepEqual(
      clientFiles,
      ordered.map(([file]) => file),
      'a unit file that creates a PrismaClient must be added here with its connect-first order'
    );
  });

  finish();
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
