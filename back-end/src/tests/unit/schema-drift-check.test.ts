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
  compareCatalog,
  driftProblems,
  replayGap,
  runSchemaDriftCheck,
  SCHEMA_DRIFT_HINT,
  SCHEMA_DRIFT_LEASE_KEY,
  SCHEMA_DRIFT_LEASE_NAMESPACE,
  SCHEMA_REPLAY_HINT,
  type Catalog,
  type DriftReport,
} from '../../providers/schemaDrift';
import { schemaHints, schemaProblems } from '../../../scripts/verify-schema-objects';

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
  appliedAfterBaseline: new Set(['1_init']),
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

test('an index left INVALID by a failed concurrent build is drift, even after IF NOT EXISTS skipped it', () => {
  // A retried `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips an invalid index
  // and the migration still records as applied; this check is what makes that
  // state fail the post-deploy smoke and the hourly cron instead of passing.
  const name = 'Message_toolCallLifecycle_idx';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-invalid-'));
  try {
    const migration = '20261104230000_message_tool_call_lifecycle_index';
    fs.mkdirSync(path.join(dir, migration));
    fs.copyFileSync(
      path.resolve(__dirname, '../../../prisma/migrations', migration, 'migration.sql'),
      path.join(dir, migration, 'migration.sql')
    );
    const catalog = (valid: boolean): Catalog => ({
      ...healthy(),
      applied: new Set([migration]),
      appliedAfterBaseline: new Set([migration]),
      indexes: new Map([
        [name, valid],
        ['Undeclared_leftover_idx', valid],
      ]),
      policies: new Map(),
      rls: new Set(),
    });
    assert.deepEqual(driftProblems(compareCatalog(catalog(true), dir)), []);
    assert.deepEqual(driftProblems(compareCatalog(catalog(false), dir)), [
      `INVALID index: ${name}`,
      'INVALID index: Undeclared_leftover_idx',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a migrations source missing an applied drop reports the replay gap, never the dropped index as drift', async () => {
  // 2026-11-09: the PR #1803 production lane replayed its pre-merge checkout,
  // which lacked PR #1698's 20261105233000..2. Production had applied them, so
  // the intentionally dropped ImessageQueue_phoneBrowserTaskId_key read as
  // "missing" and the hint prescribed restoring it with a new migration.
  const intents = '20261019071000_cloud_phone_message_intents';
  const followUps = [
    '20261105233000_cloud_message_unresolved_task',
    '20261105233001_cloud_message_drop_historical_unique',
    '20261105233002_cloud_message_task_history_index',
  ];
  const copy = (dir: string, names: string[]) => {
    for (const name of names) {
      fs.mkdirSync(path.join(dir, name));
      fs.copyFileSync(
        path.resolve(__dirname, '../../../prisma/migrations', name, 'migration.sql'),
        path.join(dir, name, 'migration.sql')
      );
    }
  };
  const preMerge = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-pre-merge-'));
  const merged = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-merged-'));
  try {
    copy(preMerge, [intents]);
    copy(merged, [intents, ...followUps]);
    // Production's catalog that morning (read-only query, 2026-11-09 08:17Z).
    const production = (indexes: string[]): Catalog => ({
      ...healthy(),
      // Pre-squash history: recorded before the baseline, never a directory here.
      applied: new Set(['20250127000000_add_feedback_table', intents, ...followUps]),
      appliedAfterBaseline: new Set([intents, ...followUps]),
      indexes: new Map(indexes.map((name) => [name, true])),
      policies: new Map(),
      rls: new Set(),
    });
    const live = [
      'ImessageQueue_phoneSendOperationId_key',
      'ImessageQueue_phoneBrowserTaskId_unresolved_key',
      'ImessageQueue_phoneBrowserTaskId_idx',
    ];

    const stale = compareCatalog(production(live), preMerge);
    assert.deepEqual(driftProblems(stale), []);
    assert.deepEqual(stale.unreplayedMigrations, followUps);
    assert.deepEqual(schemaProblems(stale), [
      `unverified: the database recorded 3 applied migration(s) this migrations source lacks (${followUps.join(', ')}); migration-declared objects were not compared`,
    ]);
    assert.equal(replayGap(stale), schemaProblems(stale)[0]);
    assert.deepEqual(schemaHints(stale), [SCHEMA_REPLAY_HINT]);
    assert.ok(!schemaProblems(stale).join('\n').includes('ImessageQueue_phoneBrowserTaskId_key'));
    // The hourly cron on a replica older than the database says the same.
    const { calls, deps } = harness('token', () => production(live));
    await runSchemaDriftCheck({ ...deps, migrationsDir: preMerge });
    assert.deepEqual(calls.alerts, [schemaProblems(stale)]);

    // The commit production runs replays the drop: the live catalog is exact.
    const exact = compareCatalog(production(live), merged);
    assert.deepEqual(schemaProblems(exact), []);
    assert.deepEqual(schemaHints(exact), []);
    assert.equal(exact.checked, live.length);

    // Real drift stays drift: losing the partial unique index still fails.
    const lost = compareCatalog(production(live.slice(0, 1).concat(live.slice(2))), merged);
    assert.deepEqual(schemaProblems(lost), [
      `missing indexes: ImessageQueue_phoneBrowserTaskId_unresolved_key (${followUps[0]})`,
    ]);
    assert.deepEqual(schemaHints(lost), [SCHEMA_DRIFT_HINT]);
  } finally {
    fs.rmSync(preMerge, { recursive: true, force: true });
    fs.rmSync(merged, { recursive: true, force: true });
  }
});

test('a source far behind lists a bounded replay gap and keeps concurrent drift in the alert', async () => {
  // CodeRabbit on #1872: a long gap line must not push invalid-index or
  // exposed-table names past the alert's message limit.
  const behind = Array.from(
    { length: 40 },
    (_, i) => `2026111${String(i).padStart(4, '0')}00_m${i}`
  );
  const catalog = (): Catalog => ({
    ...healthy(),
    appliedAfterBaseline: new Set(['1_init', ...behind]),
    indexes: new Map([
      ['Agent_title_trgm_idx', true],
      ['Stale_idx', false],
    ]),
    exposed: ['Waitlist'],
  });
  const { calls, deps } = harness('token', catalog);
  await runSchemaDriftCheck(deps);
  const [gap, ...drift] = calls.alerts[0] ?? [];
  assert.equal(
    gap,
    `unverified: the database recorded 40 applied migration(s) this migrations source lacks (${behind
      .slice(0, 5)
      .join(', ')} and 35 more); migration-declared objects were not compared`
  );
  assert.ok((gap ?? '').length < 400);
  assert.deepEqual(drift, [
    'INVALID index: Stale_idx',
    'RLS disabled on anon/authenticated-readable table: Waitlist',
  ]);
});

test.after(() => fs.rmSync(migrations, { recursive: true, force: true }));
