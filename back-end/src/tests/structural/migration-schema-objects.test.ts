#!/usr/bin/env tsx
/**
 * Every index the migration history leaves in place must survive `prisma db push`
 * and must not reappear as a DROP in `prisma migrate diff`; the post-deploy
 * drift check must report objects production lost after migrating.
 *
 * Prisma introspects plain-column indexes of any access method (btree, GIN with
 * an operator class, ...). When schema.prisma omits one, Prisma treats it as
 * surplus: `db push` drops it and `migrate diff` emits `DROP INDEX`. That is how
 * the four trigram search indexes vanished from production on 2026-10-07 and
 * again on 2026-10-08 while their migrations stayed recorded as applied.
 * Expression and partial indexes are ignored by Prisma, so they are exempt.
 *
 * Executable proof of the mechanism (local Postgres):
 * docs/rca/cases/2026-06-27-stray-db-push-from-another-worktree-dropped-a-prod-column.md
 */
import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import os from 'node:os';
import {
  loadMigrationObjects,
  migrationObjectsFromSql,
} from '../../../scripts/lib/migration-objects';
import { compareCatalog, driftProblems } from '../../../scripts/verify-schema-objects';

const BACKEND_DIR = path.resolve(__dirname, '../../..');
const schema = fs.readFileSync(path.join(BACKEND_DIR, 'prisma/schema.prisma'), 'utf8');

type Model = { table: string; columns: Map<string, string>; body: string };

function parseModels(source: string): Model[] {
  const models: Model[] = [];
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const body = match[2];
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? match[1];
    const columns = new Map<string, string>();
    for (const line of body.split('\n')) {
      const field = /^\s*(\w+)\s+\S/.exec(line);
      if (!field || line.trim().startsWith('@@') || line.trim().startsWith('//')) continue;
      columns.set(field[1], /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field[1]);
    }
    models.push({ table, columns, body });
  }
  return models;
}

/** Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes. */
const pgName = (name: string) => Buffer.from(name).subarray(0, 63).toString();

/** Names Prisma gives the indexes schema.prisma declares (explicit map or default). */
function declaredIndexNames(models: Model[]): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => names.add(pgName(name));
  for (const model of models) {
    for (const line of model.body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;
      for (const mapped of trimmed.matchAll(/map:\s*"([^"]+)"/g)) add(mapped[1]);
      const block = /^@@(index|unique|id)\(\s*\[([^\]]*)\]/.exec(trimmed);
      if (block && !/map:\s*"/.test(trimmed)) {
        const cols = block[2]
          .split(',')
          .map((part) => part.trim().replace(/\(.*$/, ''))
          .filter(Boolean)
          .map((field) => model.columns.get(field) ?? field);
        const suffix = block[1] === 'index' ? 'idx' : block[1] === 'unique' ? 'key' : 'pkey';
        add(
          block[1] === 'id' ? `${model.table}_pkey` : `${model.table}_${cols.join('_')}_${suffix}`
        );
      }
      const field = /^(\w+)\s/.exec(trimmed);
      if (field && !trimmed.startsWith('@@')) {
        const column = model.columns.get(field[1]) ?? field[1];
        if (/@unique\b(?!\([^)]*map:)/.test(trimmed)) add(`${model.table}_${column}_key`);
        if (/@id\b(?!\([^)]*map:)/.test(trimmed)) add(`${model.table}_pkey`);
      }
    }
  }
  return names;
}

const models = parseModels(schema);
const modelTables = new Set(models.map((model) => model.table));
const declared = declaredIndexNames(models);
const orphaned = [...loadMigrationObjects().indexes.values()].filter(
  (decl) => decl.prismaModelable && modelTables.has(decl.table) && !declared.has(decl.name)
);

if (orphaned.length > 0) {
  console.error('Migration-declared indexes that `prisma db push` would drop:');
  for (const decl of orphaned) {
    console.error(`  - ${decl.name} on "${decl.table}" (${decl.migration})`);
  }
  console.error(
    'Declare each in schema.prisma (for trigram indexes: ' +
      '@@index([col(ops: raw("gin_trgm_ops"))], map: "<name>", type: Gin)), ' +
      'or drop it in a migration.'
  );
  process.exit(1);
}

console.log('Every Prisma-modelable migration index is declared in schema.prisma.');

// The post-deploy drift check (prod-endpoint-smoke -> verify-schema-objects)
// must report what production lost on 2026-10-08 and must replay only applied
// migrations, so a pending restore neither hides nor invents expectations.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-objects-'));
const write = (name: string, sql: string) => {
  fs.mkdirSync(path.join(fixture, name));
  fs.writeFileSync(path.join(fixture, name, 'migration.sql'), sql);
};
write(
  '1_init',
  `CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE TABLE "User" ("userId" text);
   ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING (true);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_title_trgm_idx" ON "Agent" USING GIN ("title" gin_trgm_ops);
   CREATE INDEX "Person_expr_idx" ON public."Person" USING gin ((lower(name)) gin_trgm_ops);
   CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DROP INDEX "Agent_title_trgm_idx"; END $$ LANGUAGE plpgsql;
   CREATE TRIGGER t AFTER INSERT ON "Message" FOR EACH ROW EXECUTE FUNCTION f();`
);
write('2_drop', 'DROP INDEX IF EXISTS "Person_expr_idx";');
write(
  '3_pending_restore',
  `DROP POLICY IF EXISTS "Users can select own data" ON public."User";
   CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING (true);`
);
const parsed = migrationObjectsFromSql([
  { name: 'a', sql: fs.readFileSync(path.join(fixture, '1_init', 'migration.sql'), 'utf8') },
]);
assert.equal(parsed.indexes.get('Agent_title_trgm_idx')?.prismaModelable, true);
assert.equal(parsed.indexes.get('Person_expr_idx')?.prismaModelable, false);
assert.ok(parsed.functions.has('f') && parsed.triggers.has('Message.t'), 'dollar body ignored');

const report = compareCatalog(
  {
    applied: new Set(['1_init', '2_drop']),
    indexes: new Map([['Stale_idx', false]]),
    triggers: new Set(['Message.t']),
    functions: new Set(['f']),
    policies: new Set(),
    extensions: new Set(['pg_trgm']),
    rls: new Set(),
    exposed: ['Waitlist'],
  },
  fixture
);
assert.deepEqual(driftProblems(report), [
  'missing indexes: Agent_title_trgm_idx (1_init)',
  'missing policies: User.Users can select own data (1_init)',
  'missing rls: User (1_init)',
  'INVALID index: Stale_idx',
  'RLS disabled on anon/authenticated-readable table: Waitlist',
]);
fs.rmSync(fixture, { recursive: true, force: true });
console.log('Schema-object drift check reports dropped indexes, policies and RLS.');
