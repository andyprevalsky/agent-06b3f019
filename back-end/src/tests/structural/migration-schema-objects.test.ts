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
  normalizePolicyExpr,
} from '../../providers/schemaDrift/migrationObjects';
import { compareCatalog, driftProblems } from '../../providers/schemaDrift';

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

/**
 * Current Prisma shortens an over-long default name's base and keeps its
 * `_idx`/`_key` suffix; indexes from the pg_dump baseline were cut at 63 bytes
 * instead. Both spellings name the same declared index.
 */
const prismaDefaultName = (base: string, suffix: string) =>
  pgName(
    `${Buffer.from(base)
      .subarray(0, 63 - suffix.length - 1)
      .toString()}_${suffix}`
  );

/** Names Prisma gives the indexes schema.prisma declares (explicit map or default). */
function declaredIndexNames(models: Model[]): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => names.add(pgName(name));
  const addDefault = (base: string, suffix: string) => {
    names.add(prismaDefaultName(base, suffix));
    add(`${base}_${suffix}`);
  };
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
        addDefault(block[1] === 'id' ? model.table : `${model.table}_${cols.join('_')}`, suffix);
      }
      const field = /^(\w+)\s/.exec(trimmed);
      if (field && !trimmed.startsWith('@@')) {
        const column = model.columns.get(field[1]) ?? field[1];
        if (/@unique\b(?!\([^)]*map:)/.test(trimmed)) addDefault(`${model.table}_${column}`, 'key');
        if (/@id\b(?!\([^)]*map:)/.test(trimmed)) addDefault(model.table, 'pkey');
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
   CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING ((auth.uid())::text = "userId");
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
    appliedAfterBaseline: new Set(['1_init', '2_drop']),
    indexes: new Map([['Stale_idx', false]]),
    triggers: new Set(['Message.t']),
    functions: new Set(['f']),
    policies: new Map(),
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

// A policy that keeps its name but is redefined (CodeRabbit on #1575: TO PUBLIC
// USING (true)) is drift too; the deparsed live form of the same definition is not.
const userPolicy = parsed.policyDefs.get('User.Users can select own data');
assert.deepEqual(userPolicy, {
  permissive: 'PERMISSIVE',
  cmd: 'SELECT',
  roles: ['public'],
  using: '(auth.uid())::text="userId"',
  withCheck: '',
});
const livePolicies = (using: string) =>
  compareCatalog(
    {
      applied: new Set(['1_init', '2_drop']),
      appliedAfterBaseline: new Set(['1_init', '2_drop']),
      indexes: new Map([['Agent_title_trgm_idx', true]]),
      triggers: new Set(['Message.t']),
      functions: new Set(['f']),
      policies: new Map([
        [
          'User.Users can select own data',
          { permissive: 'PERMISSIVE', cmd: 'SELECT', roles: ['public'], using, withCheck: '' },
        ],
      ]),
      extensions: new Set(['pg_trgm']),
      rls: new Set(['User']),
      exposed: [],
    },
    fixture
  );
assert.deepEqual(
  driftProblems(livePolicies(normalizePolicyExpr('((auth.uid())::text = "userId")'))),
  []
);
assert.deepEqual(driftProblems(livePolicies('true')), [
  'changed policy: User.Users can select own data (1_init): expected PERMISSIVE FOR SELECT ' +
    'TO public USING ((auth.uid())::text="userId"); live PERMISSIVE FOR SELECT TO public USING (true)',
]);
// A hand-written policy matches its deparsed live form: pg_policies adds ::text
// casts to literals and parenthesizes AND/OR operands (CodeRabbit on #1608).
const handWritten = migrationObjectsFromSql([
  {
    name: 'a',
    sql: `CREATE POLICY "svc" ON public."T" FOR ALL TO authenticated USING (auth.role() = 'service_role' AND "userId" = (auth.uid())::text);`,
  },
]).policyDefs.get('T.svc');
assert.ok(handWritten);
const deparsedLive = normalizePolicyExpr(
  `((auth.role() = 'service_role'::text) AND ("userId" = (auth.uid())::text))`
);
const handFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-objects-hand-'));
fs.mkdirSync(path.join(handFixture, '1_init'));
fs.writeFileSync(
  path.join(handFixture, '1_init', 'migration.sql'),
  `CREATE POLICY "svc" ON public."T" FOR ALL TO authenticated USING (auth.role() = 'service_role' AND "userId" = (auth.uid())::text);`
);
const handReport = (using: string) =>
  driftProblems(
    compareCatalog(
      {
        applied: new Set(['1_init']),
        appliedAfterBaseline: new Set(['1_init']),
        indexes: new Map(),
        triggers: new Set(),
        functions: new Set(),
        policies: new Map([['T.svc', { ...handWritten, using }]]),
        extensions: new Set(),
        rls: new Set(),
        exposed: [],
      },
      handFixture
    )
  );
assert.deepEqual(handReport(deparsedLive), []);
assert.equal(handReport('true').length, 1, 'a predicate rewritten to true must still alert');
fs.rmSync(handFixture, { recursive: true, force: true });

// ALTER POLICY rewrites only the clauses it names (CodeRabbit on #1608).
const altered = migrationObjectsFromSql([
  {
    name: 'a',
    sql: `CREATE POLICY "p" ON public."T" FOR SELECT TO authenticated USING (("userId" = (auth.uid())::text));
          ALTER POLICY "p" ON public."T" USING (("ownerId" = (auth.uid())::text));`,
  },
]).policyDefs.get('T.p');
assert.deepEqual(altered, {
  permissive: 'PERMISSIVE',
  cmd: 'SELECT',
  roles: ['authenticated'],
  using: '"ownerId"=(auth.uid())::text',
  withCheck: '',
});
fs.rmSync(fixture, { recursive: true, force: true });
console.log(
  'Schema-object drift check reports dropped indexes, policies (and redefinitions) and RLS.'
);
