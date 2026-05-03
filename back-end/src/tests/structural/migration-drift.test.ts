#!/usr/bin/env tsx
/* eslint-disable no-console */
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

function parseCreateTable(sql: string, state: TableState): void {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(([\s\S]+?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const body = m[2];
    const columns = new Set<string>();
    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '');
      const colMatch = trimmed.match(/^"([^"]+)"\s+/);
      if (colMatch && !trimmed.startsWith('CONSTRAINT') && !trimmed.startsWith('PRIMARY KEY')) {
        columns.add(colMatch[1]);
      }
    }
    state.set(table, columns);
  }
}

function parseAlterAddColumn(sql: string, state: TableState): void {
  const re = /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const cols = state.get(m[1]);
    if (cols) cols.add(m[2]);
  }
}

function parseAlterDropColumn(sql: string, state: TableState): void {
  const re = /ALTER\s+TABLE\s+"([^"]+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const cols = state.get(m[1]);
    if (cols) cols.delete(m[2]);
  }
}

function parseAlterRenameColumn(sql: string, state: TableState): void {
  const re = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"/gi;
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
  const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    state.delete(m[1]);
  }
}

function parseAlterRenameTable(sql: string, state: TableState): void {
  const re = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/gi;
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
      const isScalar = SCALAR_TYPES.has(rawType) || enumNames.has(rawType);
      if (!isScalar) continue;
      const mapMatch = line.match(/@map\("([^"]+)"\)/);
      columns.add(mapMatch ? mapMatch[1] : fieldName);
    }
    state.set(table, columns);
  }
  return state;
}

interface Drift {
  kind: 'orphan-table' | 'orphan-column';
  table: string;
  column?: string;
}

function compare(migrations: TableState, schema: TableState): Drift[] {
  const drift: Drift[] = [];
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
  return drift;
}

// Tables/columns that exist in prod but were intentionally dropped from the
// schema model AND have a paired drop migration scheduled. Add an entry here
// only when you ship a DROP migration in the same change.
const KNOWN_NON_PRISMA_TABLES = new Set(['_prisma_migrations', 'spatial_ref_sys']);

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
  } else {
    console.error(
      `  - Column "${d.table}"."${d.column}" exists in migration history but not in schema.prisma.\n` +
        `    Fix: add an "ALTER TABLE \\"${d.table}\\" DROP COLUMN \\"${d.column}\\"" migration,\n` +
        `         or re-add the field to model ${d.table} in schema.prisma.`
    );
  }
}
console.error(
  `\nWhy this matters: local dev uses \`prisma db push\` (auto-syncs DB to schema.prisma)\n` +
    `but prod uses \`prisma migrate deploy\` (only applies committed migrations). Drift here\n` +
    `means prod will keep an orphaned column/table that schema.prisma no longer knows about,\n` +
    `and the next INSERT will fail with a NOT NULL constraint violation.`
);
process.exit(1);
