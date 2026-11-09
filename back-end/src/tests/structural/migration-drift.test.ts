#!/usr/bin/env tsx
/**
 * Detect drift between prisma/migrations/*.sql and prisma/schema.prisma.
 *
 * Why this exists: local dev uses `prisma db push --accept-data-loss` (scripts/run.sh,
 * scripts/setup-db.sh) which silently rewrites the local DB to match schema.prisma.
 * Prod uses `prisma migrate deploy` (back-end/render.yaml), which only applies
 * committed migration files. When schema.prisma drops a model or column without
 * a paired migration, blackbox tests pass locally and prod 500s on the first
 * INSERT against the orphaned NOT NULL column.
 *
 * What this test does:
 *   1. Parses every migration.sql file in name-sort order.
 *   2. Tracks cumulative table/column state through CREATE TABLE, DROP TABLE,
 *      ALTER TABLE ADD COLUMN, and ALTER TABLE DROP COLUMN.
 *   3. Parses schema.prisma into the same shape.
 *   4. Reports any model in the migration history missing from schema, or any
 *      column in a migration table missing from the corresponding model.
 *
 * What this test does NOT catch:
 *   - Type/nullability changes
 *   - Default-value drift
 *   - Index/constraint drift
 *
 * The intent is narrow: catch the "schema drops a column, no migration" bug that
 * shipped in PR #558 and broke POST /api/agents in prod.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_DIR = path.resolve(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'prisma/migrations');
const SCHEMA_FILE = path.join(BACKEND_DIR, 'prisma/schema.prisma');

type TableState = Map<string, Set<string>>;

// Identifier prefixes vary by SQL source:
//   - Prisma-generated migrations: `"Agent"` (always double-quoted, no schema).
//   - pg_dump baseline (the squash): `public."Agent"` (schema-qualified), with
//     columns that may be quoted (`"userId"`) OR bare lowercase (`id text`).
// The parser handles both. SCHEMA_PREFIX matches an optional `public.` /
// `"public".`; IDENT matches a quoted-or-bare identifier (capture groups 1|2).
const SCHEMA_PREFIX = '(?:"?public"?\\.)?';
const NON_COLUMN_KEYWORDS = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b/i;

/**
 * Split a CREATE TABLE body into its top-level definitions.
 *
 * Splitting on newlines instead treats the continuation lines of a multi-line
 * definition as separate entries, so a wrapped foreign key like
 *
 *   CONSTRAINT "x_fkey"
 *     FOREIGN KEY ("a") REFERENCES "B"("id")
 *     ON DELETE CASCADE ON UPDATE CASCADE
 *
 * yields a line starting with `ON`, which then parses as a column named "ON"
 * and reports permanent phantom drift for a perfectly valid migration.
 * Commas at paren depth 0 are the real separators; quoted identifiers may
 * contain either character, so track quoting too.
 */
function splitTableBody(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of body) {
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseCreateTable(sql: string, state: TableState): void {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SCHEMA_PREFIX}"([^"]+)"\\s*\\(([\\s\\S]+?)\\n\\)\\s*;`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const body = m[2];
    const columns = new Set<string>();
    for (const part of splitTableBody(body)) {
      const trimmed = part.trim().replace(/\s+/g, ' ');
      if (!trimmed || NON_COLUMN_KEYWORDS.test(trimmed)) continue;
      // Column def starts with a quoted OR bare identifier followed by a type.
      const colMatch = trimmed.match(/^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+\S/);
      if (colMatch) columns.add(colMatch[1] ?? colMatch[2]);
    }
    state.set(table, columns);
  }
}

// Prisma emits multiple column changes in a single statement, e.g.
//   ALTER TABLE "Agent" ADD COLUMN "a" INT, ADD COLUMN "b" INT;
// A regex anchored on `ALTER TABLE ... ADD COLUMN` only captures the FIRST
// clause. So we match each ALTER TABLE statement (up to its terminating `;`)
// and then scan every ADD/DROP COLUMN clause inside it.
function forEachAlterStatement(sql: string, fn: (table: string, body: string) => void): void {
  const stmtRe = new RegExp(
    `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${SCHEMA_PREFIX}"([^"]+)"([\\s\\S]*?);`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = stmtRe.exec(sql)) !== null) fn(m[1], m[2]);
}

function parseAlterAddColumn(sql: string, state: TableState): void {
  forEachAlterStatement(sql, (table, body) => {
    const cols = state.get(table);
    if (!cols) return;
    const addRe =
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(body)) !== null) cols.add(a[1] ?? a[2]);
  });
}

function parseAlterDropColumn(sql: string, state: TableState): void {
  forEachAlterStatement(sql, (table, body) => {
    const cols = state.get(table);
    if (!cols) return;
    const dropRe = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
    let d: RegExpExecArray | null;
    while ((d = dropRe.exec(body)) !== null) cols.delete(d[1] ?? d[2]);
  });
}

function parseAlterRenameColumn(sql: string, state: TableState): void {
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+${SCHEMA_PREFIX}"([^"]+)"\\s+RENAME\\s+COLUMN\\s+"([^"]+)"\\s+TO\\s+"([^"]+)"`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const cols = state.get(m[1]);
    if (cols && cols.has(m[2])) {
      cols.delete(m[2]);
      cols.add(m[3]);
    }
  }
}

function parseDropTable(sql: string, state: TableState): void {
  const re = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${SCHEMA_PREFIX}"([^"]+)"`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    state.delete(m[1]);
  }
}

function parseAlterRenameTable(sql: string, state: TableState): void {
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+${SCHEMA_PREFIX}"([^"]+)"\\s+RENAME\\s+TO\\s+${SCHEMA_PREFIX}"([^"]+)"`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const cols = state.get(m[1]);
    if (cols) {
      state.delete(m[1]);
      state.set(m[2], cols);
    }
  }
}

function buildMigrationState(): TableState {
  const state: TableState = new Map();
  const entries = fs.readdirSync(MIGRATIONS_DIR).sort();
  for (const entry of entries) {
    const sqlPath = path.join(MIGRATIONS_DIR, entry, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    parseCreateTable(sql, state);
    parseAlterAddColumn(sql, state);
    parseAlterRenameColumn(sql, state);
    parseAlterDropColumn(sql, state);
    parseAlterRenameTable(sql, state);
    parseDropTable(sql, state);
  }
  return state;
}

// Prisma scalar types that map to DB columns (non-exhaustive but covers
// everything in this schema). Anything else with a capitalized type token is
// treated as a relation/enum.
const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);

function parseSchemaPrisma(): TableState {
  const state: TableState = new Map();
  const text = fs.readFileSync(SCHEMA_FILE, 'utf-8');
  // Collect enum names so enum-typed columns count as DB columns, not relations.
  const enumNames = new Set<string>();
  const enumRe = /^enum\s+(\w+)\s*\{/gm;
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(text)) !== null) enumNames.add(em[1]);

  const modelRe = /^model\s+(\w+)\s*\{([\s\S]+?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(text)) !== null) {
    const body = m[2];
    const tableNameMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = tableNameMatch ? tableNameMatch[1] : m[1];
    const columns = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const fieldMatch = line.match(/^(\w+)\s+(\S+)/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1];
      // Strip `?`, `[]`, attributes from the type token.
      const rawType = fieldMatch[2].replace(/[?[\]]/g, '');
      // `Unsupported("vector(1024)")` is a real DB column Prisma cannot type.
      const isScalar =
        SCALAR_TYPES.has(rawType) || enumNames.has(rawType) || rawType.startsWith('Unsupported(');
      if (!isScalar) continue;
      const mapMatch = line.match(/@map\("([^"]+)"\)/);
      columns.add(mapMatch ? mapMatch[1] : fieldName);
    }
    state.set(table, columns);
  }
  return state;
}

interface Drift {
  kind: 'orphan-table' | 'orphan-column' | 'missing-table' | 'missing-column';
  table: string;
  column?: string;
}

function compare(migrations: TableState, schema: TableState): Drift[] {
  const drift: Drift[] = [];
  // Direction 1 (migrations -> schema): a table/column exists in the migration
  // history but not in schema.prisma. This is the "dropped a model/column but
  // forgot the DROP migration" bug (PR #558).
  for (const [table, migCols] of migrations) {
    const schemaCols = schema.get(table);
    if (!schemaCols) {
      drift.push({ kind: 'orphan-table', table });
      continue;
    }
    for (const col of migCols) {
      if (!schemaCols.has(col)) {
        drift.push({ kind: 'orphan-column', table, column: col });
      }
    }
  }
  // Direction 2 (schema -> migrations): a model/column exists in schema.prisma
  // but NO migration ever creates it. Local `db push` conjures the table from
  // schema.prisma so blackbox tests pass, but prod `migrate deploy` never
  // creates it, so every query 500s with "table does not exist". This is the
  // ComputeTokenLineageLease incident (2026-07-06). This is the direction the
  // original test was missing.
  for (const [table, schemaCols] of schema) {
    const migCols = migrations.get(table);
    if (!migCols) {
      drift.push({ kind: 'missing-table', table });
      continue;
    }
    for (const col of schemaCols) {
      if (!migCols.has(col)) {
        drift.push({ kind: 'missing-column', table, column: col });
      }
    }
  }
  return drift;
}

// Non-Prisma tables that live in the DB but have no schema.prisma model:
// Prisma's own bookkeeping table and PostGIS's system table. The migration
// history was squashed to a single pg_dump baseline on 2026-07-06 (see
// prisma/migrations/00000000000000_init), so the previous "known incomplete
// history" allowlist is gone — the baseline now creates every model, and the
// reverse-direction check fails the build on ANY new untracked model/column.
const KNOWN_NON_PRISMA_TABLES = new Set(['_prisma_migrations', 'spatial_ref_sys']);

// Private phone tables never expose encrypted grants through the Data API.
// The registered iphone-rls blackbox separately exercises actual PostgreSQL roles.
const phoneSql = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.includes('_iphone_'))
  .sort()
  .map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'))
  .join('\n');
for (const table of ['IPhoneDevice', 'IPhoneLease', 'IPhoneOperation', 'IPhoneAcquireIntent']) {
  if (!phoneSql.includes(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`))
    throw new Error(`Private phone table ${table} has no RLS migration`);
}
if (
  !phoneSql.includes('REVOKE ALL ON TABLE') ||
  !phoneSql.includes("ARRAY['anon', 'authenticated']")
)
  throw new Error('Private phone migrations must revoke client table ACLs');

const drift = compare(buildMigrationState(), parseSchemaPrisma()).filter(
  (d) => !KNOWN_NON_PRISMA_TABLES.has(d.table)
);

if (drift.length === 0) {
  console.log('No migration drift detected.');
  process.exit(0);
}

console.error('Migration drift detected:');
for (const d of drift) {
  if (d.kind === 'orphan-table') {
    console.error(
      `  - Table "${d.table}" exists in migration history but not in schema.prisma.\n` +
        `    Fix: add a "DROP TABLE" migration, or re-add the model to schema.prisma.`
    );
  } else if (d.kind === 'orphan-column') {
    console.error(
      `  - Column "${d.table}"."${d.column}" exists in migration history but not in schema.prisma.\n` +
        `    Fix: add an "ALTER TABLE \\"${d.table}\\" DROP COLUMN \\"${d.column}\\"" migration,\n` +
        `         or re-add the field to model ${d.table} in schema.prisma.`
    );
  } else if (d.kind === 'missing-table') {
    console.error(
      `  - Model "${d.table}" exists in schema.prisma but NO migration creates it.\n` +
        `    Fix: author a "CREATE TABLE \\"${d.table}\\"" migration directory\n` +
        `         (prisma migrate dev --create-only). A loose .sql file in the\n` +
        `         migrations root is NOT enough — it must be <timestamp>_<name>/migration.sql.`
    );
  } else {
    console.error(
      `  - Column "${d.table}"."${d.column}" exists in schema.prisma but NO migration creates it.\n` +
        `    Fix: author an "ALTER TABLE \\"${d.table}\\" ADD COLUMN \\"${d.column}\\"" migration.`
    );
  }
}
console.error(
  `\nWhy this matters: local dev uses \`prisma db push\` (auto-syncs DB to schema.prisma)\n` +
    `but prod uses \`prisma migrate deploy\` (only applies committed migrations). Drift here\n` +
    `means prod's schema diverges from schema.prisma: orphaned columns fail the next INSERT\n` +
    `with a NOT NULL violation, and models with no migration 500 every query with\n` +
    `"table does not exist" (the ComputeTokenLineageLease incident).`
);
process.exit(1);
