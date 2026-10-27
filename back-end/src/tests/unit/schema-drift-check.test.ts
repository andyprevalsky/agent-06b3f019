#!/usr/bin/env tsx
/**
 * S21: production RLS stayed off for 18 days after the 2026-10-08 stray db push
 * because nothing compared the live catalog with the migrations between
 * deploys. The hourly check must run on exactly one replica (shared lease),
 * alert once with every problem, stay silent on a clean catalog, and be
 * registered in production cron.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  runSchemaDriftCheck,
  SCHEMA_DRIFT_LEASE_KEY,
  SCHEMA_DRIFT_LEASE_NAMESPACE,
  type Catalog,
  type DriftReport,
} from '../../providers/schemaDrift';

const migrations = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-cron-'));
fs.mkdirSync(path.join(migrations, '1_init'));
fs.writeFileSync(
  path.join(migrations, '1_init', 'migration.sql'),
  `ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING ((auth.uid())::text = "userId");
   CREATE INDEX "Agent_title_trgm_idx" ON "Agent" USING GIN ("title" gin_trgm_ops);`
);

const healthy = (): Catalog => ({
  applied: new Set(['1_init']),
  indexes: new Map([['Agent_title_trgm_idx', true]]),
  triggers: new Set(),
  functions: new Set(),
  policies: new Map([
    [
      'User.Users can select own data',
      {
        permissive: 'PERMISSIVE',
        cmd: 'SELECT',
        roles: ['public'],
        using: '(auth.uid())::text="userId"',
        withCheck: '',
      },
    ],
  ]),
  extensions: new Set(),
  rls: new Set(['User']),
  exposed: [],
});

/** The 2026-10-08 state: RLS off and anon-readable, policy gone, index dropped. */
const drifted = (): Catalog => ({
  ...healthy(),
  indexes: new Map(),
  policies: new Map(),
  rls: new Set(),
  exposed: ['User'],
});

function harness(lease: string | null, catalog: () => Catalog) {
  const calls = { lease: [] as unknown[][], reads: 0, alerts: [] as string[][] };
  const deps = {
    acquireLease: async (...args: [string, string, number]) => {
      calls.lease.push(args);
      return lease;
    },
    readCatalog: async () => {
      calls.reads += 1;
      return catalog();
    },
    alert: (problems: string[], _report: DriftReport) => {
      calls.alerts.push(problems);
    },
    migrationsDir: migrations,
  };
  return { calls, deps };
}

test('a replica that loses the hourly lease neither reads the catalog nor alerts', async () => {
  const { calls, deps } = harness(null, drifted);
  assert.deepEqual(await runSchemaDriftCheck(deps), { acquired: false });
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.alerts, []);
  assert.equal(calls.lease[0]?.[0], SCHEMA_DRIFT_LEASE_NAMESPACE);
  assert.equal(calls.lease[0]?.[1], SCHEMA_DRIFT_LEASE_KEY);
  assert.ok(Number(calls.lease[0]?.[2]) < 60 * 60 * 1000, 'lease must expire before the next hour');
});

test('the lease holder alerts once with the RLS exposure, missing policy and index', async () => {
  const { calls, deps } = harness('token', drifted);
  const result = await runSchemaDriftCheck(deps);
  assert.equal(result.acquired, true);
  assert.equal(calls.alerts.length, 1);
  assert.deepEqual(calls.alerts[0], [
    'missing indexes: Agent_title_trgm_idx (1_init)',
    'missing policies: User.Users can select own data (1_init)',
    'missing rls: User (1_init)',
    'RLS disabled on anon/authenticated-readable table: User',
  ]);
});

test('a policy redefined to USING (true) under the same name alerts', async () => {
  const catalog = healthy();
  const policy = catalog.policies.get('User.Users can select own data');
  assert.ok(policy);
  catalog.policies.set('User.Users can select own data', { ...policy, using: 'true' });
  const { calls, deps } = harness('token', () => catalog);
  await runSchemaDriftCheck(deps);
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0]?.[0] ?? '', /^changed policy: User\.Users can select own data/);
});

test('a clean catalog is checked without an alert', async () => {
  const { calls, deps } = harness('token', healthy);
  const result = await runSchemaDriftCheck(deps);
  assert.deepEqual(result, { acquired: true, checked: 3, problems: [] });
  assert.equal(calls.reads, 1);
  assert.deepEqual(calls.alerts, []);
});

test('production cron registers the hourly schema drift check', () => {
  const cronSource = fs.readFileSync(path.resolve(__dirname, '../../serverCron.ts'), 'utf8');
  const register = cronSource.slice(cronSource.indexOf('export function registerCronJobs'));
  assert.match(register, /scheduleSchemaDriftCheck\(isProduction\);/);
  assert.match(cronSource, /runProductionSchemaDriftCheck\(\)/);
  // A check that throws must still reach #errors, not only stderr.
  assert.match(cronSource, /Schema drift check failed[\s\S]{0,400}alertError\(\{/);
  assert.match(
    cronSource,
    /cron\.schedule\('\d+ \* \* \* \*', run\);\n {2}cronLog\.info\('Schema drift/
  );
});

test.after(() => fs.rmSync(migrations, { recursive: true, force: true }));
