/**
 * Read-only check that a database still holds every index, trigger, function,
 * RLS policy, enabled row-level security and extension its applied migrations
 * declare.
 *
 *   npx tsx scripts/verify-schema-objects.ts            # DIRECT_URL/DATABASE_URL (prod from back-end/.env)
 *   npx tsx scripts/verify-schema-objects.ts --json     # machine-readable report
 *
 * Exits 1 on any missing object, INVALID index or public table readable by
 * anon/authenticated without RLS, 2 on a connection/query
 * error. Only migrations recorded as applied in `_prisma_migrations` are
 * replayed, so a deploy that has not yet run a new migration does not fail.
 * Every catalog read runs in a READ ONLY transaction with a 15s timeout.
 */
import 'dotenv/config';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { loadMigrationObjects } from './lib/migration-objects';

type Catalog = {
  applied: Set<string>;
  indexes: Map<string, boolean>;
  triggers: Set<string>;
  functions: Set<string>;
  policies: Set<string>;
  extensions: Set<string>;
  rls: Set<string>;
  /** Public tables anon/authenticated can SELECT through the Data API with RLS off. */
  exposed: string[];
};

async function readCatalog(prisma: PrismaClient): Promise<Catalog> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
      const applied = await tx.$queryRawUnsafe<Array<{ migration_name: string }>>(
        `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
      );
      const indexes = await tx.$queryRawUnsafe<Array<{ name: string; valid: boolean }>>(
        `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relnamespace = 'public'::regnamespace`
      );
      const triggers = await tx.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT r.relname || '.' || t.tgname AS key
       FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND r.relnamespace = 'public'::regnamespace`
      );
      const functions = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace`
      );
      const policies = await tx.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT tablename || '.' || policyname AS key FROM pg_policies WHERE schemaname = 'public'`
      );
      const extensions = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT extname AS name FROM pg_extension`
      );
      const rls = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT relname AS name FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relrowsecurity`
      );
      const exposed = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND NOT c.relrowsecurity
         AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
                     AND has_table_privilege(r.oid, c.oid, 'SELECT'))`
      );
      return {
        applied: new Set(applied.map((row) => row.migration_name)),
        indexes: new Map(indexes.map((row) => [row.name, row.valid])),
        triggers: new Set(triggers.map((row) => row.key)),
        functions: new Set(functions.map((row) => row.name)),
        policies: new Set(policies.map((row) => row.key)),
        extensions: new Set(extensions.map((row) => row.name)),
        rls: new Set(rls.map((row) => row.name)),
        exposed: exposed.map((row) => row.name),
      };
      // Prisma's interactive-transaction defaults (2s wait, 5s lifetime) are
      // shorter than eight catalog reads on a busy pooler; each read keeps its
      // own 15s statement limit.
    },
    { maxWait: 15_000, timeout: 60_000 }
  );
}

export const SCHEMA_DRIFT_HINT =
  'Schema drift: objects were removed after their migrations were recorded applied. ' +
  'Restore them with a new idempotent migration; never with an ad-hoc db push.';

export type DriftReport = {
  missing: Record<
    'indexes' | 'triggers' | 'functions' | 'policies' | 'extensions' | 'rls',
    string[]
  >;
  invalidIndexes: string[];
  /** Every public table needs RLS: Supabase grants anon/authenticated SELECT by default. */
  exposedTables: string[];
  checked: number;
};

export function compareCatalog(catalog: Catalog, migrationsDir?: string): DriftReport {
  // Replay only what the target recorded as applied, so a pending migration
  // neither adds expectations nor hides objects an applied one still declares.
  const expected = loadMigrationObjects(migrationsDir, catalog.applied);
  const missing: DriftReport['missing'] = {
    indexes: [],
    triggers: [],
    functions: [],
    policies: [],
    extensions: [],
    rls: [],
  };
  const invalidIndexes: string[] = [];
  let checked = 0;
  for (const decl of expected.indexes.values()) {
    checked += 1;
    const valid = catalog.indexes.get(decl.name);
    if (valid === undefined) missing.indexes.push(`${decl.name} (${decl.migration})`);
    else if (!valid) invalidIndexes.push(decl.name);
  }
  const sets: Array<[keyof DriftReport['missing'], Map<string, string>, Set<string>]> = [
    ['triggers', expected.triggers, catalog.triggers],
    ['functions', expected.functions, catalog.functions],
    ['policies', expected.policies, catalog.policies],
    ['extensions', expected.extensions, catalog.extensions],
    ['rls', expected.rls, catalog.rls],
  ];
  for (const [kind, declared, live] of sets) {
    for (const [name, migration] of declared) {
      checked += 1;
      if (!live.has(name)) missing[kind].push(`${name} (${migration})`);
    }
  }
  // An INVALID index left by a failed concurrent build is drift even when
  // undeclared: IF NOT EXISTS would skip rebuilding it.
  for (const [name, valid] of catalog.indexes) {
    if (!valid && !invalidIndexes.includes(name)) invalidIndexes.push(name);
  }
  return { missing, invalidIndexes, exposedTables: [...catalog.exposed].sort(), checked };
}

/** Reads the target catalog and compares it with the applied migration history. */
export async function verifySchemaObjects(url: string): Promise<DriftReport> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    return compareCatalog(
      await readCatalog(prisma),
      path.resolve(__dirname, '../prisma/migrations')
    );
  } finally {
    await prisma.$disconnect();
  }
}

export function driftProblems(report: DriftReport): string[] {
  const problems: string[] = [];
  for (const [kind, list] of Object.entries(report.missing)) {
    for (const item of list) problems.push(`missing ${kind}: ${item}`);
  }
  for (const name of report.invalidIndexes) problems.push(`INVALID index: ${name}`);
  for (const name of report.exposedTables) {
    problems.push(`RLS disabled on anon/authenticated-readable table: ${name}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL or DATABASE_URL must be set');
  const report = await verifySchemaObjects(url);
  const problems = driftProblems(report);
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, ...report }, null, 2));
  } else {
    console.log(`Checked ${report.checked} migration-declared objects.`);
    for (const problem of problems) console.log(`❌ ${problem}`);
    console.log(
      problems.length === 0
        ? '✅ Every migration-declared schema object is present.'
        : SCHEMA_DRIFT_HINT
    );
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
