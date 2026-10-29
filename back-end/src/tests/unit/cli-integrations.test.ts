import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Prisma } from '@prisma/client';

const templateEnvironment = {
  CODE_SANDBOX_GRID: JSON.stringify({ cpu: [2], memoryGb: [4] }),
  CODE_SANDBOX_DEFAULT_CPU: '2',
  CODE_SANDBOX_DEFAULT_MEMORY_GB: '4',
  E2B_SANDBOX_TEMPLATES: '',
  E2B_CLAUDE_CODE_TEMPLATE_ID: 'fixture-claude-template',
  E2B_CODEX_CODE_TEMPLATE_ID: 'fixture-codex-template',
};
const originalTemplateEnvironment = Object.fromEntries(
  Object.keys(templateEnvironment).map((key) => [key, process.env[key]])
);

type Row = {
  id: string;
  userId: string;
  status: string;
  config: Record<string, unknown>;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};
const rows: Row[] = [];
let receipt: { metadata: Prisma.JsonValue } | null = null;
let executions = 0;
let exitCode = 0;
let templateAvailable = true;
let transportFailure = false;
let nativeHead: { recipes: unknown[] } = { recipes: [] };
let verificationGate: Promise<void> | null = null;
let superseded = false;
let nativeBuilds = 0;
let revokePublisher = false;
let beforeSessionRead: (() => void) | undefined;
let secured = 0;
let agentStatus = 'ACTIVE';
const requests: Array<Record<string, unknown>> = [];
const db = {
  integration: {
    create: async ({ data }: { data: Row }) => {
      if (rows.some((row) => row.id === data.id))
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      const row = { ...data, failureReason: null, createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
    findMany: async ({
      where,
    }: {
      where: { userId: string; status?: string; id?: { not: string } };
    }) =>
      rows.filter(
        (row) =>
          row.userId === where.userId &&
          (!where.status || row.status === where.status) &&
          (!where.id || row.id !== where.id.not)
      ),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((row) => row.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    findUnique: async () => ({ config: nativeHead }),
    updateMany: async ({
      where,
      data,
    }: {
      where: {
        id?: string | { in: string[] };
        config?: { equals?: unknown; path?: string[] };
        status?: string | { not: string };
        AND?: Array<{ config: { path: string[]; equals?: unknown; gt?: number } }>;
      };
      data: Partial<Row>;
    }) => {
      if (!where.id) return { count: 1 };
      if (typeof where.id !== 'string') {
        for (const row of rows.filter((item) =>
          (where.id as { in: string[] }).in.includes(item.id)
        ))
          Object.assign(row, data);
        return { count: 1 };
      }
      const row = rows.find((item) => item.id === where.id);
      if (!row) return { count: 0 };
      if (
        where.AND?.some(({ config }) =>
          config.equals !== undefined
            ? row.config[config.path[0]] !== config.equals
            : !(Number(row.config[config.path[0]]) > Number(config.gt))
        )
      )
        return { count: 0 };
      if (typeof where.status === 'string' && row.status !== where.status) return { count: 0 };
      if (typeof where.status === 'object' && row.status === where.status.not) return { count: 0 };
      if (where.config?.path && row.config[where.config.path[0]] !== where.config.equals)
        return { count: 0 };
      if (
        !where.config?.path &&
        where.config?.equals &&
        JSON.stringify(row.config) !== JSON.stringify(where.config.equals)
      )
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  agent: {
    findMany: async () =>
      rows.map((row) => ({ id: row.config.agent_id, status: agentStatus, deletedAt: null })),
    findUnique: async () => null,
  },
  claudeCodeSession: {
    findUnique: async () => ({
      agentId: 'setup-agent',
      codeSessionId: 'template',
      status: 'ACTIVE',
    }),
  },
  codeSession: {
    findUnique: async () => {
      beforeSessionRead?.();
      return templateAvailable
        ? {
            id: 'template',
            userId: 'owner',
            state: 'PAUSED',
            sandboxKind: 'e2b',
            sandboxId: 'sandbox',
          }
        : null;
    },
    findMany: async () => (templateAvailable ? [{ id: 'template' }] : []),
    updateMany: async (args: Record<string, unknown>) => {
      requests.push(args);
      return { count: 1 };
    },
  },
  message: {
    findUnique: async () => receipt,
    create: async ({ data }: { data: { metadata: Prisma.JsonValue } }) => {
      receipt = data;
      return data;
    },
    update: async ({ data }: { data: { metadata: Prisma.JsonValue } }) => {
      receipt = data;
      return data;
    },
  },
};

async function main() {
  // database is mocked, so no dotenv side effects may supply this fixture's templates.
  Object.assign(process.env, templateEnvironment);
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: db,
      runTransactionWithRetry: async (fn: (db: unknown) => Promise<unknown>) => fn(db),
    },
  });
  await mock.module('../../providers/cliTemplate', {
    namedExports: {
      readTemplateCredentials: async () => [{ path: '.yc/credentials.json', data: 'e30=' }],
      executeTemplateCli: async () => {
        executions += 1;
        if (verificationGate) await verificationGate;
        if (transportFailure) throw new Error('connection lost');
        return { exit_code: exitCode, stdout: 'account@example.test', stderr: '' };
      },
    },
  });
  await mock.module('../../providers/userCodeTemplates', {
    namedExports: {
      UserCodeTemplateError: class extends Error {},
      publishUserCodeTemplate: async (
        _user: string,
        _id: string,
        recipe: { install: string },
        variants: unknown[],
        builder: () => Promise<string>
      ) => {
        nativeHead = {
          recipes: [superseded ? { ...recipe, connectionId: 'newer-connection' } : recipe],
        };
        assert.equal(recipe.install, 'official-installer');
        assert.deepEqual(
          variants,
          [
            {
              key: 'claude-2x4',
              provider: 'claude',
              cpu: 2,
              memoryGb: 4,
              baseTemplateId: 'fixture-claude-template',
            },
            {
              key: 'codex-2x4',
              provider: 'codex',
              cpu: 2,
              memoryGb: 4,
              baseTemplateId: 'fixture-codex-template',
            },
          ],
          'builds the configured template for each provider'
        );
        await builder();
        if (revokePublisher) {
          const row = rows.find((item) => item.id === _id)!;
          row.config = {
            ...row.config,
            publishing_token: 'successor',
            publishing_expires_at: Date.now() + 90_000,
          };
        }
        return { revision: 1 };
      },
    },
  });
  await mock.module('../../providers/nativeCliTemplateBuilder', {
    namedExports: {
      buildNativeCliTemplate: async () => {
        nativeBuilds++;
        return 'immutable-snapshot';
      },
    },
  });
  await mock.module('../../providers/cliNativeCredentials', {
    namedExports: {
      initializeCliCredentials: async () => {
        secured++;
      },
    },
  });
  const cli = await import('../../providers/cliIntegrations');
  const { cliCommand } = await import('../../providers/cliTemplate');
  assert.equal(
    cliCommand('/bin/yc', ['$(touch /tmp/unsafe)', "a'b"], 'task'),
    "exec env YC_CLI_SESSION='task' '/bin/yc' '$(touch /tmp/unsafe)' 'a'\\''b'"
  );
  let launches = 0;
  const launch = async () => {
    launches += 1;
  };
  const first = await cli.createCliIntegration('owner', 'YC CLI', 'request-a', launch);
  const duplicate = await cli.createCliIntegration('owner', 'YC CLI', 'request-a', launch);
  assert.equal(first.id, duplicate.id);
  assert.equal(launches, 1, 'retries cannot spawn another setup agent');
  await assert.rejects(
    cli.createCliIntegration('owner', 'Different CLI', 'request-a', launch),
    /different CLI/
  );
  const other = await cli.createCliIntegration('other', 'YC CLI', 'request-a', launch);
  assert.notEqual(first.id, other.id, 'request ids are scoped to owner');
  agentStatus = 'COMPLETED';
  assert.equal(
    (await cli.listCliIntegrations('owner')).integrations[0].status,
    'failed',
    'completion without publication is not a connection'
  );
  agentStatus = 'ACTIVE';
  rows[0].config.agent_id = 'setup-agent';
  const caller = { userId: 'owner', agentId: 'setup-agent', taskId: 'task' };
  await assert.rejects(
    cli.publishCliIntegration({ ...caller, userId: 'other' }, first.id, {
      name: 'YC',
      command: '/home/user/bin/yc',
      verify: ['whoami'],
    }),
    /not found/
  );
  const beforeInvalidPublish = executions;
  await assert.rejects(
    cli.publishCliIntegration(caller, first.id, {
      name: 'YC',
      command: '/home/user/bin/yc',
      verify: ['whoami'],
      install: 'installer',
    }),
    /Installation verification and credential paths are required/
  );
  assert.equal(executions, beforeInvalidPublish, 'invalid install input cannot execute auth');
  assert.equal(rows[0].config.publishing_auth_inflight, undefined);
  exitCode = 1;
  await assert.rejects(
    cli.publishCliIntegration(caller, first.id, {
      name: 'YC',
      command: '/home/user/bin/yc',
      verify: ['whoami'],
    }),
    /verification command failed/
  );
  assert.equal(rows[0].status, 'SYNCING');
  assert.equal(
    rows[0].config.publishing_auth_inflight,
    undefined,
    'known failed verification releases auth fence'
  );
  exitCode = 0;
  const published = await cli.publishCliIntegration(caller, first.id, {
    name: 'YC',
    command: '/home/user/bin/yc',
    verify: ['whoami'],
  });
  assert.equal(published.integration.status, 'connected');
  templateAvailable = false;
  assert.equal((await cli.listCliIntegrations('owner')).integrations[0].status, 'failed');
  templateAvailable = true;
  const before = executions;
  const result = await cli.runCliIntegration(caller, first.id, ['whoami'], 'run-a');
  assert.equal(result.stdout, 'account@example.test');
  assert.deepEqual(await cli.runCliIntegration(caller, first.id, ['whoami'], 'run-a'), result);
  assert.equal(executions, before + 1, 'durable receipts replay the result');
  await assert.rejects(
    cli.runCliIntegration(caller, first.id, ['delete'], 'run-a'),
    /different command/
  );
  receipt = null;
  transportFailure = true;
  await assert.rejects(
    cli.runCliIntegration(caller, first.id, ['whoami'], 'run-b'),
    /outcome is unknown/
  );
  const afterFailure = executions;
  await assert.rejects(
    cli.runCliIntegration(caller, first.id, ['whoami'], 'run-b'),
    /will not be executed again/
  );
  assert.equal(executions, afterFailure);
  assert(
    requests.some((request) => JSON.stringify(request).includes('leaseOwner')),
    'template is leased and released'
  );
  receipt = null;
  transportFailure = false;
  rows[0].status = 'SYNCING';
  const nativeBody = {
    name: 'YC',
    command: '/home/user/bin/yc',
    verify: ['whoami'],
    install: 'official-installer',
    install_verify: ['--version'],
    credential_files: ['.yc/credentials.json'],
  };
  let allowVerification!: () => void;
  verificationGate = new Promise<void>((resolve) => {
    allowVerification = resolve;
  });
  const publishing = cli.publishCliIntegration(caller, first.id, nativeBody);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(cli.publishCliIntegration(caller, first.id, nativeBody), /already running/);
  allowVerification();
  verificationGate = null;
  await publishing;
  assert.equal(rows[0].config.native_template, true);
  assert.equal(rows[0].config.template_revision, 1);
  assert.equal(secured, 1);
  assert.equal(nativeBuilds, 1);
  await cli.publishCliIntegration(caller, first.id, nativeBody);
  assert.equal(nativeBuilds, 1, 'published retry never rebuilds or refreshes auth');
  templateAvailable = false;
  assert.equal(
    (await cli.listCliIntegrations('owner')).integrations[0].status,
    'connected',
    'native snapshot does not depend on setup sandbox retention'
  );
  await assert.rejects(
    cli.runCliIntegration(caller, first.id, ['whoami'], 'native-run'),
    /installed native CLI/
  );
  templateAvailable = true;
  const replacement = await cli.createCliIntegration(
    'owner',
    'YC CLI',
    'reconnect-request',
    launch
  );
  const replacementRow = rows.find((row) => row.id === replacement.id)!;
  replacementRow.config.agent_id = 'setup-agent';
  await cli.publishCliIntegration(caller, replacement.id, nativeBody);
  assert.equal(replacementRow.status, 'CONNECTED', 'reconnect gets fresh credential authority');
  assert.equal(rows[0].status, 'EXPIRED', 'old auth authority is superseded');
  const older = await cli.createCliIntegration('owner', 'YC CLI', 'older-request', launch);
  rows.find((row) => row.id === older.id)!.config.agent_id = 'setup-agent';
  superseded = true;
  await assert.rejects(cli.publishCliIntegration(caller, older.id, nativeBody), /newer setup/);
  assert.equal(
    replacementRow.status,
    'CONNECTED',
    'late older publication cannot revoke newer login'
  );
  const fencedSetup = await cli.createCliIntegration('owner', 'YC CLI', 'fenced-setup', launch);
  const fencedRow = rows.find((item) => item.id === fencedSetup.id)!;
  fencedRow.config.agent_id = 'setup-agent';
  superseded = false;
  revokePublisher = true;
  await assert.rejects(
    cli.publishCliIntegration(caller, fencedSetup.id, nativeBody),
    /lease expired or was replaced/
  );
  assert.equal(fencedRow.status, 'SYNCING', 'lost publisher cannot promote connection');
  assert.equal(
    fencedRow.config.publishing_token,
    'successor',
    'lost publisher cannot erase successor claim'
  );
  assert.equal(
    replacementRow.status,
    'CONNECTED',
    'lost publisher cannot expire current connection'
  );
  const delayedSetup = await cli.createCliIntegration(
    'owner',
    'Delayed CLI',
    'delayed-auth',
    launch
  );
  const delayedRow = rows.find((item) => item.id === delayedSetup.id)!;
  delayedRow.config.agent_id = 'setup-agent';
  beforeSessionRead = () => {
    delayedRow.config = {
      ...delayedRow.config,
      publishing_token: 'new-owner',
      publishing_expires_at: Date.now() + 90_000,
    };
  };
  const beforeStaleExecution = executions;
  await assert.rejects(
    cli.publishCliIntegration(caller, delayedSetup.id, nativeBody),
    /lease expired or was replaced/
  );
  assert.equal(
    executions,
    beforeStaleExecution,
    'lost owner during DB reads cannot execute authenticated command'
  );
  assert.equal(delayedRow.config.publishing_token, 'new-owner');
  beforeSessionRead = undefined;
  const ambiguousSetup = await cli.createCliIntegration(
    'owner',
    'Unknown CLI',
    'unknown-auth',
    launch
  );
  const ambiguousRow = rows.find((item) => item.id === ambiguousSetup.id)!;
  ambiguousRow.config.agent_id = 'setup-agent';
  transportFailure = true;
  await assert.rejects(
    cli.publishCliIntegration(caller, ambiguousSetup.id, nativeBody),
    /connection lost/
  );
  assert.equal(
    ambiguousRow.config.publishing_auth_inflight,
    true,
    'unknown execution preserves auth fence'
  );
  transportFailure = false;
  process.stdout.write(
    'CLI integrations: ownership, setup dedupe, verified publication, unavailable template, receipt replay and uncertain execution passed\n'
  );
}
main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const [key, value] of Object.entries(originalTemplateEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
