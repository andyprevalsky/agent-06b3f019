import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type * as Runner from '../../providers/projects/maintenanceRunner';
import type * as Store from '../../providers/projects/maintenanceStore';

type ProjectRow = {
  id: string;
  maintenanceRunId: string | null;
  maintenanceLeaseUntil: Date | null;
  templateSnapshotId: string | null;
  templatePrevSnapshotId: string | null;
};
type Where = { id?: string; maintenanceRunId?: string; status?: string };

/** Execute the actual runner AND store; only I/O and time are fake. */
function fixture(
  options: {
    lostAtRestore?: boolean;
    restoreError?: boolean;
    lostAtPublish?: boolean;
    slowSetup?: boolean;
    resetError?: boolean;
  } = {}
) {
  let now = 0;
  const clock = () => new Date(now);
  const row: ProjectRow = {
    id: 'project',
    maintenanceRunId: 'run',
    maintenanceLeaseUntil: new Date(1_080_000),
    templateSnapshotId: 'previous',
    templatePrevSnapshotId: 'oldest',
  };
  const run = { id: 'run', status: 'RUNNING', startedAt: clock(), logTail: null };
  const events: string[] = [];
  const deleted: string[] = [];
  const commandTimeouts: number[] = [];
  let sandboxDeadline = 0;
  const matches = (where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.maintenanceRunId === undefined || row.maintenanceRunId === where.maintenanceRunId);
  const project = {
    updateMany: async ({ where, data }: { where: Where; data: Partial<ProjectRow> }) => {
      if (data.maintenanceLeaseUntil instanceof Date) events.push('renew');
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    findFirst: async ({ where }: { where: Where }) => (matches(where) ? { ...row } : null),
    findMany: async () =>
      row.maintenanceRunId !== null &&
      row.maintenanceLeaseUntil !== null &&
      row.maintenanceLeaseUntil.getTime() < now
        ? [{ ...row }]
        : [],
  };
  const projectMaintenanceRun = {
    updateMany: async ({ where, data }: { where: Where; data: Partial<typeof run> }) => {
      if (where.id !== run.id || (where.status !== undefined && where.status !== run.status)) {
        return { count: 0 };
      }
      Object.assign(run, data);
      return { count: 1 };
    },
    findMany: async () => [],
    findUnique: async () => run,
  };
  const prisma = { project, projectMaintenanceRun };
  function load<T>(file: string, dependencies: Record<string, unknown>): T {
    const source = readFileSync(join(__dirname, '../../providers/projects', file), 'utf8');
    const code = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    const scope = {
      exports: {},
      Buffer,
      Date,
      Error,
      process: { env: { E2B_API_KEY: 'fixture-key' } },
      require: (name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
        return dependencies[name];
      },
    };
    runInNewContext(code, scope, { filename: file });
    return scope.exports as T;
  }
  const store = load<typeof Store>('maintenanceStore.ts', {
    '@prisma/client': { Prisma: { DbNull: null } },
    '../database': {
      prisma,
      runTransactionWithRetry: async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    },
    './maintenanceSchedule': {},
  });
  const ex = {
    writeFileInside: async () => {
      events.push('script-write');
      return '/home/user/.rose/project/maintenance.sh';
    },
    run: async (command: string, opts: { timeoutMs: number }) => {
      commandTimeouts.push(opts.timeoutMs);
      if (options.slowSetup && command.startsWith('awk ')) now += 120_000;
      if (command.startsWith('bash ')) {
        events.push('script');
        now += 480_000;
        // A real cron tick while the long script finishes: uses the actual store.
        await store.reconcileStaleRuns(clock());
        if (now >= sandboxDeadline) throw new Error('sandbox expired during script');
      }
      return {
        exitCode: 0,
        stdout: command === 'git rev-parse HEAD' ? 'a'.repeat(40) : '4096',
        stderr: '',
      };
    },
  };
  const runner = load<typeof Runner>('maintenanceRunner.ts', {
    './maintenanceStore': store,
    '../logger': { createLogger: () => ({ info() {}, warn() {}, error() {} }) },
    './workspace': {
      redactor: () => (text: string) => text,
      tokenOf: () => [],
      projectSessionPaths: () => ({
        homeDir: '/home/user',
        repoDir: '/home/user/workspace',
        projectDir: '/home/user/.rose/project',
      }),
      restoreWorkspace: async () => {
        now += 540_000;
        events.push('restore');
        if (options.lostAtRestore) {
          row.maintenanceRunId = 'successor';
          row.maintenanceLeaseUntil = new Date(now + 1_080_000);
        }
        return {
          checkout: {
            source: 'remote',
            headSha: 'a'.repeat(40),
            error: options.restoreError ? 'clone failed' : null,
          },
          filesWritten: [],
        };
      },
    },
    './workspaceExecutor': {
      e2bWorkspaceExecutor: () => ex,
      registerWorkspaceExecutor: () => events.push('register'),
      unregisterWorkspaceExecutor: () => events.push('unregister'),
      shq: (s: string) => `'${s}'`,
    },
  });
  const input = {
    project: {
      id: 'project',
      maintenanceTimeoutS: 480,
      maintenanceScript: 'echo sync',
      repoUrl: 'https://example.test/repo',
      templateSnapshotSize: null,
    },
    workspace: {
      redactions: [],
      cloneUrl: 'https://example.test/repo',
      project: { defaultBranch: 'main' },
    },
    run: { ...run, fromSnapshotId: null },
    mode: 'sync',
  } as unknown as Runner.MaintenanceRunInput;
  const deps: Runner.MaintenanceDeps = {
    homeDir: '/home/user',
    now: clock,
    baseTemplate: () => ({ templateId: 'base', size: { cpu: 2, memoryGb: 4 } }),
    createSandbox: async (_id, opts) => {
      assert.equal(opts.timeoutMs, 1_080_000, 'sandbox timeout is unchanged');
      now += 120_000;
      sandboxDeadline = now + opts.timeoutMs;
      events.push('create');
      return {
        sandboxId: 'owned-sandbox',
        kill: async () => {
          events.push('kill');
        },
        createSnapshot: async () => {
          now += 10_000;
          assert(now < sandboxDeadline, 'the example stays inside the original sandbox lifetime');
          events.push('snapshot');
          if (options.lostAtPublish) row.maintenanceRunId = 'successor';
          return { snapshotId: 'new' };
        },
      } as Runner.MaintenanceSandbox;
    },
    setSandboxTimeout: async (sandboxId, timeoutMs) => {
      assert.equal(sandboxId, 'owned-sandbox');
      assert.equal(timeoutMs, 1_080_000, 'reset uses the unchanged configured lifetime');
      events.push('sandbox-renew');
      if (options.resetError) throw new Error('sandbox timeout reset failed');
      sandboxDeadline = now + timeoutMs;
    },
    deleteSnapshot: async (id) => {
      deleted.push(id);
      return true;
    },
  };
  const adapter = load<typeof import('../../providers/projects/maintenanceE2b')>(
    'maintenanceE2b.ts',
    {
      e2b: {
        Sandbox: {
          setTimeout: async (id: string, ms: number, auth: { apiKey: string }) => {
            assert.equal(id, 'owned-sandbox');
            assert.equal(ms, 1_080_000);
            assert.equal(auth.apiKey, 'fixture-key');
            assert.equal(Object.keys(auth).join(','), 'apiKey');
            events.push('adapter-reset');
          },
        },
      },
      '../e2bSandboxCreate': {},
      '../claudeCodeTemplate': {},
      '../codeSessions/sandboxSize': {},
      './workspace': { E2B_HOME: '/home/user' },
    }
  );
  return {
    adapter,
    execute: () => runner.executeMaintenanceRun(input, deps),
    row,
    run,
    events,
    deleted,
    commandTimeouts,
  };
}

export function registerMaintenanceLeaseCases(): void {
  test('slow maintenance setup renews ownership before the full script budget', async () => {
    const f = fixture();
    const outcome = await f.execute();
    assert.equal(outcome.status, 'SUCCEEDED', outcome.error ?? undefined);
    assert.equal(f.row.templateSnapshotId, 'new');
    assert.equal(f.row.templatePrevSnapshotId, 'previous');
    assert.equal(f.run.status, 'SUCCEEDED');
    assert.equal(f.row.maintenanceRunId, null);
    assert.equal(f.row.maintenanceLeaseUntil, null);
    assert.deepEqual(f.deleted, ['oldest']);
    assert.equal(f.events.filter((x) => x === 'renew').length, 1);
    assert(f.events.indexOf('restore') < f.events.indexOf('renew'));
    assert(f.events.indexOf('renew') < f.events.indexOf('script-write'));
    assert.equal(f.events.filter((x) => x === 'kill').length, 1);
    assert(f.events.includes('unregister'));
    assert(f.commandTimeouts.includes(480_000), 'full original script timeout retained');
    assert(f.commandTimeouts.every((ms) => ms === 120_000 || ms === 480_000));
  });
  test('refused maintenance renewal runs no script and preserves successor custody', async () => {
    const f = fixture({ lostAtRestore: true });
    const outcome = await f.execute();
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /lease was lost before the sync script started/);
    for (const event of ['script-write', 'script', 'snapshot'])
      assert(!f.events.includes(event), event);
    assert.equal(f.row.maintenanceRunId, 'successor');
    assert.equal(f.row.maintenanceLeaseUntil?.getTime(), 1_740_000);
    assert.equal(f.row.templateSnapshotId, 'previous');
    assert.equal(f.row.templatePrevSnapshotId, 'oldest');
    assert.deepEqual(f.deleted, []);
    assert.equal(f.run.status, 'FAILED');
    assert.equal(f.events.filter((x) => x === 'kill').length, 1);
    assert(f.events.includes('unregister'));
  });
  test('maintenance restore failure still settles without renewing or starting a script', async () => {
    const f = fixture({ restoreError: true });
    assert.equal((await f.execute()).error, 'clone failed');
    for (const event of ['renew', 'script-write', 'script', 'snapshot'])
      assert(!f.events.includes(event), event);
    assert.equal(f.row.maintenanceRunId, null);
    assert.equal(f.row.templateSnapshotId, 'previous');
    assert(f.events.includes('kill'));
  });
  test('maintenance publication still fences a successor after successful renewal', async () => {
    const f = fixture({ lostAtPublish: true });
    const outcome = await f.execute();
    assert.equal(outcome.status, 'FAILED');
    assert.match(outcome.error ?? '', /lease was lost before the snapshot could be published/);
    assert.deepEqual(f.deleted, ['new']);
    assert.equal(f.row.templateSnapshotId, 'previous');
    assert.equal(f.row.maintenanceRunId, 'successor');
    assert(f.events.includes('kill'));
  });
  test('setup consuming sandbox slack resets lifetime before the full script', async () => {
    const f = fixture({ slowSetup: true });
    const outcome = await f.execute();
    assert.equal(outcome.status, 'SUCCEEDED', outcome.error ?? undefined);
    assert.equal(f.row.templateSnapshotId, 'new');
    assert.equal(f.row.templatePrevSnapshotId, 'previous');
    assert.equal(f.run.status, 'SUCCEEDED');
    assert.equal(f.row.maintenanceRunId, null);
    assert.deepEqual(f.deleted, ['oldest']);
    assert.equal(f.events.filter((event) => event === 'sandbox-renew').length, 1);
    assert(f.events.indexOf('renew') < f.events.indexOf('sandbox-renew'));
    assert(f.events.indexOf('sandbox-renew') < f.events.indexOf('script-write'));
    assert.equal(f.events.filter((event) => event === 'kill').length, 1);
    assert(f.events.includes('unregister'));
    assert(f.commandTimeouts.includes(480_000));
    assert(f.commandTimeouts.every((ms) => ms === 120_000 || ms === 480_000));
  });
  test('sandbox lifetime reset failure starts no script and cleans owned resources', async () => {
    const f = fixture({ resetError: true });
    const outcome = await f.execute();
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.error, 'sandbox timeout reset failed');
    assert(f.events.includes('sandbox-renew'));
    for (const event of ['script-write', 'script', 'snapshot'])
      assert(!f.events.includes(event), event);
    assert.equal(f.row.templateSnapshotId, 'previous');
    assert.equal(f.row.templatePrevSnapshotId, 'oldest');
    assert.equal(f.row.maintenanceRunId, null);
    assert.equal(f.row.maintenanceLeaseUntil, null);
    assert.equal(f.run.status, 'FAILED');
    assert.deepEqual(f.deleted, []);
    assert.equal(f.events.filter((event) => event === 'kill').length, 1);
    assert(f.events.includes('unregister'));
  });
  test('lost project ownership never renews the sandbox lifetime', async () => {
    const f = fixture({ lostAtRestore: true });
    assert.equal((await f.execute()).status, 'FAILED');
    assert(!f.events.includes('sandbox-renew'));
    assert(!f.events.includes('script'));
    assert.equal(f.row.maintenanceRunId, 'successor');
    assert.equal(f.row.maintenanceLeaseUntil?.getTime(), 1_740_000);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.events.filter((event) => event === 'kill').length, 1);
  });
  test('production maintenance adapter forwards sandbox identity lifetime and auth', async () => {
    const f = fixture();
    await f.adapter.e2bMaintenanceDeps().setSandboxTimeout('owned-sandbox', 1_080_000);
    assert.deepEqual(f.events, ['adapter-reset']);
  });
}
