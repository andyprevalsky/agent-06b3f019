import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../../providers/database';

/** Replay the migration DDL: db push does not preserve or verify RLS policy. */
export async function assertResizeMigrationIsolation(): Promise<void> {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `resize_rls_${suffix}`;
  const role = `resize_client_${suffix}`;
  const migration = readFileSync(
    join(__dirname, '../../../prisma/migrations/20261020235500_code_sandbox_sizes/migration.sql'),
    'utf8'
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    for (const table of ['User', 'Project', 'CodeSession']) {
      await tx.$executeRawUnsafe(`CREATE TABLE "${table}" (id text)`);
    }
    // This migration contains ordinary DDL only, without procedural bodies.
    for (const statement of migration.split(';').filter((part) => part.trim())) {
      await tx.$executeRawUnsafe(statement);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "CodeSessionResize" (id,"codeSessionId","userId","agentId",
       "fromCpu","fromMemoryGb","toCpu","toMemoryGb",reason)
       VALUES ('resize-a','session-a','other-user','agent-a',2,4,8,16,'build demand')`
    );
    const backendRows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM "CodeSessionResize"'
    );
    assert.equal(backendRows[0]?.count, 1, 'the backend still reads its bookkeeping');

    await tx.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await tx.$executeRawUnsafe(`GRANT SELECT ON "CodeSessionResize" TO "${role}"`);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
    const clientRows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM "CodeSessionResize"'
    );
    await tx.$executeRawUnsafe('RESET ROLE');
    assert.equal(clientRows[0]?.count, 0, "a client role must not read another user's resize");

    const tables = await tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean }>>(
      `SELECT relrowsecurity FROM pg_class
       WHERE relnamespace = $1::regnamespace AND relname = 'CodeSessionResize'`,
      schema
    );
    assert.equal(tables[0]?.relrowsecurity, true);
    const policies = await tx.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM pg_policies
       WHERE schemaname = $1 AND tablename = 'CodeSessionResize'`,
      schema
    );
    assert.equal(policies[0]?.count, 0, 'resize bookkeeping is backend-only');
    await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await tx.$executeRawUnsafe(`DROP ROLE "${role}"`);
  });
}
