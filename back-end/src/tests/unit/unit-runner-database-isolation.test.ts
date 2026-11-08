#!/usr/bin/env tsx

/**
 * Owning-boundary regression: unit files that create their own schema and take
 * the queue-admission advisory lock collided on one database. Advisory locks
 * are per DATABASE (not per schema), so concurrent files, and the coverage
 * gate's blackbox backend, blocked each other's exclusive lock until Prisma's
 * 10s interactive transactions expired (P2028, or a 120s hang).
 *
 * The unit runner must give every self-schema file a private database.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import {
  createIsolatedDatabase,
  ISOLATED_DATABASE_FILES,
} from '../../../scripts/unit-test-database-isolation';

const unitDir = __dirname;

function tryLock(client: PrismaClient, key: string): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ acquired: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`;
    return rows[0]?.acquired === true;
  });
}

async function main(): Promise<void> {
  // 1. Every unit file that builds its own schema is isolated by the runner.
  const selfSchemaFiles = readdirSync(unitDir)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => /CREATE SCHEMA/.test(readFileSync(join(unitDir, name), 'utf8')))
    .filter((name) => name !== 'unit-runner-database-isolation.test.ts');
  assert.ok(selfSchemaFiles.length > 0, 'expected self-schema unit files to exist');
  for (const name of selfSchemaFiles) {
    assert.ok(
      ISOLATED_DATABASE_FILES.has(name),
      `${name} creates its own schema but is not in ISOLATED_DATABASE_FILES ` +
        '(scripts/unit-test-database-isolation.ts); advisory locks are per database'
    );
  }
  for (const name of ISOLATED_DATABASE_FILES) {
    assert.ok(
      readdirSync(unitDir).includes(name),
      `${name} is listed for isolation but is not a unit file`
    );
  }

  // 2. A lock held on the shared database does not block the private database.
  const baseUrl = process.env.DATABASE_URL;
  assert.equal(nonLocalDatabaseReason(baseUrl), null, 'explicit local test database required');
  const isolated = createIsolatedDatabase(baseUrl!);
  const holder = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  // The engine's one-time TLS setenv must finish before another client reads process.env.
  await holder.$connect();
  const sameDatabase = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  const privateDatabase = new PrismaClient({ datasources: { db: { url: isolated.url } } });
  try {
    const key = `unit-runner-isolation-${isolated.name}`;
    let sameDatabaseAcquired: boolean | undefined;
    let privateDatabaseAcquired: boolean | undefined;
    await holder.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      sameDatabaseAcquired = await tryLock(sameDatabase, key);
      privateDatabaseAcquired = await tryLock(privateDatabase, key);
    });
    assert.strictEqual(
      sameDatabaseAcquired,
      false,
      'control: the same lock key must be held across the shared database'
    );
    assert.strictEqual(
      privateDatabaseAcquired,
      true,
      'a private database must not see a lock held in the shared database'
    );
  } finally {
    await privateDatabase.$disconnect();
    await sameDatabase.$disconnect();
    isolated.drop();
    const remaining = await holder.$queryRaw<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${isolated.name}`;
    await holder.$disconnect();
    assert.strictEqual(remaining[0]?.n, 0, 'the private database must be dropped after use');
  }

  process.stdout.write('unit-runner-database-isolation: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
