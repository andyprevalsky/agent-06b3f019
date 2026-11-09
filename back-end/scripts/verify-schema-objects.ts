/**
 * Read-only check that a database still holds every index, trigger, function,
 * RLS policy (name and definition), enabled row-level security and extension
 * its applied migrations declare. Logic: src/providers/schemaDrift (also run
 * hourly in production by serverCron).
 *
 *   npx tsx scripts/verify-schema-objects.ts            # DIRECT_URL/DATABASE_URL (prod from back-end/.env)
 *   npx tsx scripts/verify-schema-objects.ts --json     # machine-readable report
 *   SCHEMA_MIGRATIONS_DIR=<dir> npx tsx scripts/verify-schema-objects.ts
 *                     # replay another source, e.g. the commit production runs
 *
 * Exits 1 on any missing object, INVALID index or public table readable by
 * anon/authenticated without RLS, 2 on a connection/query
 * error. Only migrations recorded as applied in `_prisma_migrations` are
 * replayed, so a deploy that has not yet run a new migration does not fail. A
 * source that lacks a migration the database applied (an older checkout) cannot
 * be compared and fails as an unverified replay, never as drift.
 * Every catalog read runs in a READ ONLY transaction with a 15s timeout.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  CATALOG_TRANSACTION_OPTIONS,
  compareCatalog,
  driftProblems,
  readCatalogInTransaction,
  replayGap,
  SCHEMA_DRIFT_HINT,
  SCHEMA_REPLAY_HINT,
  type DriftReport,
} from '../src/providers/schemaDrift';

export { compareCatalog, driftProblems, replayGap, type DriftReport };

/** Reads the target catalog and compares it with the applied migration history. */
export async function verifySchemaObjects(
  url: string,
  migrationsDir = process.env.SCHEMA_MIGRATIONS_DIR || undefined
): Promise<DriftReport> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    return compareCatalog(
      await prisma.$transaction(readCatalogInTransaction, CATALOG_TRANSACTION_OPTIONS),
      migrationsDir
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** Every failing line: the replay gap first, then drift. */
export function schemaProblems(report: DriftReport): string[] {
  const gap = replayGap(report);
  return [...(gap ? [gap] : []), ...driftProblems(report)];
}

/** Remedies for the problems schemaProblems reported. */
export function schemaHints(report: DriftReport): string[] {
  return [
    ...(replayGap(report) ? [SCHEMA_REPLAY_HINT] : []),
    ...(driftProblems(report).length > 0 ? [SCHEMA_DRIFT_HINT] : []),
  ];
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL or DATABASE_URL must be set');
  const report = await verifySchemaObjects(url);
  const problems = schemaProblems(report);
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, ...report }, null, 2));
  } else {
    console.log(`Checked ${report.checked} migration-declared objects.`);
    for (const problem of problems) console.log(`❌ ${problem}`);
    if (problems.length === 0) console.log('✅ Every migration-declared schema object is present.');
    for (const hint of schemaHints(report)) console.log(hint);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
