/**
 * Read-only check that a database still holds every index, trigger, function,
 * RLS policy (name AND definition), enabled row-level security and extension
 * its applied migrations declare, and that no public table is readable by
 * anon/authenticated without RLS.
 *
 *   applied migrations ──► loadMigrationObjects ──┐
 *                                                 ├─► compareCatalog ─► driftProblems
 *   live pg_catalog (READ ONLY, 15s) ─► readCatalog┘
 *
 * Two callers: the post-deploy smoke (scripts/verify-schema-objects.ts) and the
 * hourly production cron (runSchemaDriftCheck). The 2026-10-08 stray db push
 * left RLS off for 18 days because nothing checked between deploys.
 *
 * Scale: one bounded catalog read per hour for the whole fleet (a leader lease
 * picks one replica); cost is O(schema objects), independent of agent count.
 */
import type { Prisma } from '@prisma/client';
import { loadMigrationObjects, normalizePolicyExpr, type PolicyDef } from './migrationObjects';

export type Catalog = {
  applied: Set<string>;
  indexes: Map<string, boolean>;
  triggers: Set<string>;
  functions: Set<string>;
  /** Key: `${table}.${policy}` */
  policies: Map<string, PolicyDef>;
  extensions: Set<string>;
  rls: Set<string>;
  /** Public tables anon/authenticated can SELECT through the Data API with RLS off. */
  exposed: string[];
};

/** Interactive-transaction limits: eight catalog reads, each capped at 15s. */
export const CATALOG_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

/**
 * Read the catalog inside the caller's interactive transaction (run it with
 * CATALOG_TRANSACTION_OPTIONS): it first makes the transaction READ ONLY with a
 * 15s statement limit.
 */
export async function readCatalogInTransaction(tx: Prisma.TransactionClient): Promise<Catalog> {
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
  const policies = await tx.$queryRawUnsafe<
    Array<{
      key: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>
  >(
    `SELECT tablename || '.' || policyname AS key, permissive, roles::text[] AS roles,
              cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`
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
                     -- Column-level grants expose a table too; has_table_privilege misses them.
                     AND has_any_column_privilege(r.oid, c.oid, 'SELECT'))`
  );
  return {
    applied: new Set(applied.map((row) => row.migration_name)),
    indexes: new Map(indexes.map((row) => [row.name, row.valid])),
    triggers: new Set(triggers.map((row) => row.key)),
    functions: new Set(functions.map((row) => row.name)),
    policies: new Map(
      policies.map((row): [string, PolicyDef] => [
        row.key,
        {
          permissive: row.permissive === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE',
          cmd: row.cmd as PolicyDef['cmd'],
          roles: [...row.roles].sort(),
          using: normalizePolicyExpr(row.qual),
          withCheck: normalizePolicyExpr(row.with_check),
        },
      ])
    ),
    extensions: new Set(extensions.map((row) => row.name)),
    rls: new Set(rls.map((row) => row.name)),
    exposed: exposed.map((row) => row.name),
  };
}

export const SCHEMA_DRIFT_HINT =
  'Schema drift: objects were removed or changed after their migrations were recorded applied. ' +
  'Restore them with a new idempotent migration; never with an ad-hoc db push.';

export type DriftReport = {
  missing: Record<
    'indexes' | 'triggers' | 'functions' | 'policies' | 'extensions' | 'rls',
    string[]
  >;
  /** Policies present by name whose roles, command or expressions differ from the migration. */
  changedPolicies: string[];
  invalidIndexes: string[];
  /** Every public table needs RLS: Supabase grants anon/authenticated SELECT by default. */
  exposedTables: string[];
  checked: number;
};

function describePolicy(def: PolicyDef): string {
  return [
    def.permissive,
    `FOR ${def.cmd}`,
    `TO ${def.roles.join(',')}`,
    def.using ? `USING (${def.using})` : '',
    def.withCheck ? `WITH CHECK (${def.withCheck})` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * pg_policies deparses hand-written expressions: literals gain casts
 * (`'service_role'` -> `'service_role'::text`) and AND/OR operands gain
 * parentheses. Compare with casts and grouping removed so a correct hand-written
 * policy does not alert; a changed predicate, role or command still differs.
 */
function samePolicy(want: PolicyDef, live: PolicyDef): boolean {
  const loose = (expr: string) =>
    expr.replace(/::[a-z_][a-z0-9_ ]*(?:\[\])?/gi, '').replace(/[()]/g, '');
  return (
    want.permissive === live.permissive &&
    want.cmd === live.cmd &&
    want.roles.join(',') === live.roles.join(',') &&
    loose(want.using) === loose(live.using) &&
    loose(want.withCheck) === loose(live.withCheck)
  );
}

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
  const changedPolicies: string[] = [];
  const invalidIndexes: string[] = [];
  let checked = 0;
  for (const decl of expected.indexes.values()) {
    checked += 1;
    const valid = catalog.indexes.get(decl.name);
    if (valid === undefined) missing.indexes.push(`${decl.name} (${decl.migration})`);
    else if (!valid) invalidIndexes.push(decl.name);
  }
  for (const [key, migration] of expected.policies) {
    checked += 1;
    const live = catalog.policies.get(key);
    if (!live) {
      missing.policies.push(`${key} (${migration})`);
      continue;
    }
    const want = expected.policyDefs.get(key);
    if (want && !samePolicy(want, live)) {
      changedPolicies.push(
        `${key} (${migration}): expected ${describePolicy(want)}; live ${describePolicy(live)}`
      );
    }
  }
  const sets: Array<[keyof DriftReport['missing'], Map<string, string>, Set<string>]> = [
    ['triggers', expected.triggers, catalog.triggers],
    ['functions', expected.functions, catalog.functions],
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
  return {
    missing,
    changedPolicies,
    invalidIndexes,
    exposedTables: [...catalog.exposed].sort(),
    checked,
  };
}

export function driftProblems(report: DriftReport): string[] {
  const problems: string[] = [];
  for (const [kind, list] of Object.entries(report.missing)) {
    for (const item of list) problems.push(`missing ${kind}: ${item}`);
  }
  for (const item of report.changedPolicies) problems.push(`changed policy: ${item}`);
  for (const name of report.invalidIndexes) problems.push(`INVALID index: ${name}`);
  for (const name of report.exposedTables) {
    problems.push(`RLS disabled on anon/authenticated-readable table: ${name}`);
  }
  return problems;
}

export const SCHEMA_DRIFT_LEASE_NAMESPACE = 'cron';
export const SCHEMA_DRIFT_LEASE_KEY = 'schema-drift-hourly';
/** Held (not released) for most of the hour so exactly one replica checks per tick. */
export const SCHEMA_DRIFT_LEASE_TTL_MS = 50 * 60 * 1000;

export type SchemaDriftCheckDeps = {
  acquireLease: (namespace: string, key: string, ttlMs: number) => Promise<string | null>;
  readCatalog: () => Promise<Catalog>;
  alert: (problems: string[], report: DriftReport) => void;
  migrationsDir?: string;
};

export type SchemaDriftCheckResult =
  { acquired: false } | { acquired: true; checked: number; problems: string[] };

/**
 * One hourly tick: the replica that wins the lease reads the catalog and alerts
 * once with every problem. A clean catalog sends nothing.
 */
export async function runSchemaDriftCheck(
  deps: SchemaDriftCheckDeps
): Promise<SchemaDriftCheckResult> {
  const token = await deps.acquireLease(
    SCHEMA_DRIFT_LEASE_NAMESPACE,
    SCHEMA_DRIFT_LEASE_KEY,
    SCHEMA_DRIFT_LEASE_TTL_MS
  );
  if (!token) return { acquired: false };
  const report = compareCatalog(await deps.readCatalog(), deps.migrationsDir);
  const problems = driftProblems(report);
  if (problems.length > 0) deps.alert(problems, report);
  return { acquired: true, checked: report.checked, problems };
}
