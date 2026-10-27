/**
 * The read-only migration preflight catches, on a target's own data, the two
 * migrations that passed every gate and then failed in production at Render
 * start (`prisma migrate deploy`), blocking all deploys:
 *
 *   2026-10-02  20260929120000 (original): INSERT ... SELECT over every Message
 *               → statement timeout 57014              → expect [whole-table]
 *   2026-10-26  20261026160000..160004: VALIDATE CHECK ("userId" IS NOT NULL)
 *               after a backfill that cannot fill 4 orphan rows
 *               (personId without a Person)            → expect 4 violations
 *
 * Each case runs against a scratch database on the local server shaped like
 * production at that moment, then proves the repaired data / migration passes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { databaseUrl, localServerUrl } from './compute-token-authority.support';

const backendDir = path.resolve(__dirname, '../../..');
const tsx = path.resolve(backendDir, '../node_modules/.bin/tsx');
const migrations = path.join(backendDir, 'prisma/migrations');
const fixtures = path.join(backendDir, 'src/tests/fixtures/migration-preflight');

function preflight(url: string, files: string[], extra: string[] = []) {
  const run = spawnSync(
    tsx,
    [
      'scripts/migration-preflight.ts',
      '--database-url',
      url,
      ...files.flatMap((file) => ['--migration', file]),
      ...extra,
    ],
    { cwd: backendDir, encoding: 'utf8', timeout: 120_000 }
  );
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

async function withScratchDatabase(
  label: string,
  fn: (client: PrismaClient, url: string) => Promise<void>
): Promise<void> {
  const name = `preflight_${label}_${crypto.randomBytes(4).toString('hex')}`;
  const url = databaseUrl(localServerUrl(), name);
  const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    await fn(client, url);
  } finally {
    await client.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}

async function orphanRowsFailValidate(): Promise<void> {
  await withScratchDatabase('orphan', async (client, url) => {
    // Production MessageRecord/Person before the S7 rollout (no userId yet).
    await client.$executeRawUnsafe(
      `CREATE TABLE "Person" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL)`
    );
    await client.$executeRawUnsafe(
      `CREATE TABLE "MessageRecord" (id TEXT PRIMARY KEY, "personId" TEXT NOT NULL,
         "timestamp" TIMESTAMP(3) NOT NULL DEFAULT now(), message TEXT)`
    );
    await client.$executeRawUnsafe(
      `CREATE INDEX "MessageRecord_timestamp_idx" ON "MessageRecord"("timestamp")`
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Person" SELECT 'p' || i, 'u' || (i % 7) FROM generate_series(1, 50) i`
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "MessageRecord" (id, "personId") SELECT 'm' || i, 'p' || (1 + i % 50) FROM generate_series(1, 400) i`
    );
    // The four 2026-09-04 rows whose Person no longer exists.
    await client.$executeRawUnsafe(
      `INSERT INTO "MessageRecord" (id, "personId") SELECT 'orphan' || i, 'gone' || i FROM generate_series(1, 4) i`
    );
    await client.$executeRawUnsafe('ANALYZE');
    const files = [
      '20261026160000_message_record_user_id',
      '20261026160001_message_record_user_id_backfill',
      '20261026160002_person_id_user_id_key',
      '20261026160003_message_record_user_id_constraints',
      '20261026160004_message_record_user_id_validate',
    ].map((dir) => path.join(migrations, dir));

    const failed = preflight(url, files);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /MIGRATION PREFLIGHT FAILED/);
    assert.match(
      failed.output,
      /20261026160004_message_record_user_id_validate \[validate MessageRecord_userId_not_null\] 4 existing row\(s\) in "MessageRecord" violate it/,
      failed.output
    );
    assert.match(
      failed.output,
      /statement: ALTER TABLE "MessageRecord" VALIDATE CONSTRAINT "MessageRecord_userId_not_null"/
    );
    assert.match(
      failed.output,
      /measured with: SELECT count\(\*\)::bigint AS violations FROM "MessageRecord" m WHERE/
    );
    // Read-only: the target is untouched.
    const [{ count }] = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM information_schema.columns
       WHERE table_name = 'MessageRecord' AND column_name = 'userId'`
    );
    assert.equal(Number(count), 0, 'the preflight must not apply any migration');

    // Once the orphans are repaired the same migrations pass.
    await client.$executeRawUnsafe(`DELETE FROM "MessageRecord" WHERE "personId" LIKE 'gone%'`);
    const passed = preflight(url, files);
    assert.equal(passed.code, 0, passed.output);
    assert.match(passed.output, /0 violating rows in "MessageRecord"/);
  });
  process.stdout.write(
    'PASS orphan rows that a backfill cannot fill fail VALIDATE before merge (2026-10-26)\n'
  );
}

async function wholeTableBackfillFails(): Promise<void> {
  await withScratchDatabase('timeout', async (client, url) => {
    await client.$executeRawUnsafe(`CREATE TABLE "User" ("userId" TEXT PRIMARY KEY)`);
    await client.$executeRawUnsafe(
      `CREATE TABLE "Agent" (id TEXT PRIMARY KEY, "parentAgentId" TEXT, "userId" TEXT,
         source TEXT NOT NULL DEFAULT 'WEB', goal TEXT NOT NULL DEFAULT '', title TEXT)`
    );
    await client.$executeRawUnsafe(
      `CREATE TABLE "Message" (id TEXT PRIMARY KEY, "agentId" TEXT NOT NULL, role TEXT NOT NULL,
         text TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now())`
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Agent" (id, "userId", goal) SELECT 'a' || i, 'u1', 'goal ' || i FROM generate_series(1, 200) i`
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Message" (id, "agentId", role, text)
       SELECT 'msg' || i, 'a' || (1 + i % 200), 'ASSISTANT', 'text ' || i FROM generate_series(1, 20000) i`
    );
    await client.$executeRawUnsafe('ANALYZE');
    const limit = ['--max-scan-rows', '5000'];

    const failed = preflight(
      url,
      [path.join(fixtures, '20260929120000_agent_trajectory_search')],
      limit
    );
    assert.equal(failed.code, 1, failed.output);
    assert.match(
      failed.output,
      /20260929120000_agent_trajectory_search \[whole-table\] Seq Scan on "Message" reads ~20,000 rows/,
      failed.output
    );
    assert.match(
      failed.output,
      /statement: WITH RECURSIVE roots AS \(.*INSERT INTO "AgentTrajectorySearch"/
    );
    assert.match(failed.output, /measured with: EXPLAIN \(FORMAT JSON\) WITH RECURSIVE roots AS/);

    // The repaired, schema-only migration that shipped passes on the same data.
    const passed = preflight(
      url,
      [path.join(migrations, '20260929120000_agent_trajectory_search')],
      limit
    );
    assert.equal(passed.code, 0, passed.output);
  });
  process.stdout.write('PASS a whole-table boot-time backfill fails before merge (2026-10-02)\n');
}

async function columnDefaultsAndBatchedClauses(): Promise<void> {
  await withScratchDatabase('defaults', async (client, url) => {
    await client.$executeRawUnsafe(`CREATE TABLE "Widget" (id TEXT PRIMARY KEY)`);
    await client.$executeRawUnsafe(
      `INSERT INTO "Widget" SELECT 'w' || i FROM generate_series(1, 50) i`
    );
    await client.$executeRawUnsafe('ANALYZE');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-defaults-'));
    const write = (name: string, sql: string) => {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'migration.sql'), sql);
      return path.join(dir, name);
    };
    try {
      // Existing rows receive the DEFAULT, so SET NOT NULL rejects none of them.
      const defaulted = write(
        '20990101000000_flag_default',
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE "Widget" ADD COLUMN "flag" BOOLEAN DEFAULT false;
ALTER TABLE "Widget" ALTER COLUMN "flag" SET NOT NULL;`
      );
      const ok = preflight(url, [defaulted]);
      assert.equal(ok.code, 0, ok.output);
      assert.match(ok.output, /0 violating rows in "Widget"/);

      // Prisma batches columns into one ALTER TABLE; a DEFAULT on one clause must
      // not hide a NOT NULL column without one, even with a comma in its type.
      const batched = write(
        '20990101000001_batched_add',
        `ALTER TABLE "Widget" ADD COLUMN "a" TEXT NOT NULL DEFAULT 'x', ADD COLUMN "price" DECIMAL(65,30) NOT NULL;`
      );
      const failed = preflight(url, [batched]);
      assert.equal(failed.code, 1, failed.output);
      assert.match(
        failed.output,
        /\[add not-null column price without default\] 50 existing row\(s\) in "Widget"/,
        failed.output
      );
      assert.doesNotMatch(failed.output, /add not-null column a without default/);

      // SERIAL fills existing rows from its sequence; a quoted name that merely
      // says "default" supplies nothing.
      const serial = write(
        '20990101000002_serial',
        `ALTER TABLE "Widget" ADD COLUMN "n" SERIAL NOT NULL;`
      );
      const serialRun = preflight(url, [serial]);
      assert.equal(serialRun.code, 0, serialRun.output);
      const quoted = write(
        '20990101000003_quoted_default_name',
        `ALTER TABLE "Widget" ADD COLUMN "default" TEXT NOT NULL;`
      );
      const quotedRun = preflight(url, [quoted]);
      assert.equal(quotedRun.code, 1, quotedRun.output);
      assert.match(quotedRun.output, /\[add not-null column default without default\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  process.stdout.write(
    'PASS column DEFAULTs fill existing rows and every batched ADD COLUMN clause is judged\n'
  );
}

async function main(): Promise<void> {
  await orphanRowsFailValidate();
  await wholeTableBackfillFails();
  await columnDefaultsAndBatchedClauses();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
