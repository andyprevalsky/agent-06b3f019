#!/usr/bin/env tsx

// Overflow from seed-local.part2.blackbox.ts (max-lines). Compute-token any-mode,
// synthetic pool, and AgentCard launcher opt-out source invariants.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { Integration } from '@prisma/client';
import {
  syncIntegrationCredentials,
  type IntegrationModel,
} from '../../../scripts/seed-local-credentials';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readSeedLocalSource(): string {
  return readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(__dirname, '../../../../', path), 'utf8');
}

test('compute-token sync any-mode accepts Claude Code OR Codex', async () => {
  const source = readSeedLocalSource();
  const anyHelper = source.indexOf('function requireAnyComputeTokenType');
  const anyParser = source.indexOf("value.toLowerCase() === 'any'");
  const anyBranch = source.indexOf('if (requireAnyComputeTokenType())');
  const eitherOk = source.indexOf('usableClaudeCodeCount > 0 || usableGptCodeCount > 0', anyBranch);
  const eitherFailure = source.indexOf(
    "throw new Error('No usable claude_code or gpt_code integrations after sync')",
    anyBranch
  );

  assert(anyHelper > 0, 'expected an explicit any-mode helper');
  assert(anyParser > 0, 'expected parseComputeTokenRequiredTypes to accept any');
  assert(anyBranch > anyHelper, 'expected sync to branch on any-mode');
  assert(eitherOk > anyBranch, 'expected any-mode to accept either provider');
  assert(
    eitherFailure > eitherOk,
    'expected any-mode to fail only when both providers are missing'
  );
});

test('synthetic benchmark compute access uses the isolated pool without changing ownership', async () => {
  const source = readSeedLocalSource();
  const optIn = source.indexOf('SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS');
  const helper = source.indexOf('async function poolRequiredDevComputeTokensForSyntheticUsers');
  const isolationGuard = source.indexOf('if (!ISOLATED_BENCHMARK_RUN)', helper);
  const ownerBoundary = source.indexOf('userId: SEED_USER_ID', helper);
  const requiredNames = source.indexOf('COMPUTE_TOKEN_REQUIRED_TYPES', helper);
  const poolUpdate = source.indexOf('data: { poolingEnabled: true }', helper);
  const syncCall = source.indexOf(
    'const count = await syncIntegrations({ computeTokensOnly: true })',
    helper
  );
  const poolCall = source.indexOf(
    'await poolRequiredDevComputeTokensForSyntheticUsers()',
    syncCall
  );

  assert(optIn > 0, 'expected an explicit synthetic-user pool opt-in');
  assert(helper > optIn, 'expected a narrowly named pooling helper');
  assert(isolationGuard > helper, 'expected pooling to fail closed outside isolated benchmarks');
  assert(ownerBoundary > helper, 'expected the integration to retain the seed-user owner');
  assert(requiredNames > helper, 'expected pooling to be limited to required provider types');
  assert(poolUpdate > isolationGuard, 'expected the isolated-stack guard before the pool update');
  assert(poolUpdate > ownerBoundary, 'expected only the local pooling flag to change');
  assert(syncCall > helper, 'expected production-owned integrations to sync first');
  assert(poolCall > syncCall, 'expected isolated pooling only after credential sync');
  assert(
    !source.slice(helper, poolCall).includes('userId: process.env'),
    'synthetic benchmark users must never receive copied integration rows'
  );
});

test('full seed never replicates rotating Lantern grants or overwrites a dedicated local grant', async () => {
  // Execute the actual CLI function with only source/target storage edges mocked.
  // This is the existing seed-credential-retry AST replay convention: no top-level
  // seed CLI imports, environment loading, real databases or provider calls.
  const source = readSeedLocalSource();
  const ast = ts.createSourceFile('seed-local.ts', source, ts.ScriptTarget.ES2022, true);
  const functions = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'syncIntegrations'
  );
  assert(functions.length === 1, 'expected the actual syncIntegrations declaration');
  const executable = ts.transpileModule(functions[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const makeRow = (
    id: string,
    userId: string,
    name: string,
    poolingEnabled = false
  ): Integration => ({
    id,
    userId,
    name,
    poolingEnabled,
    type: 'API',
    status: 'CONNECTED',
    isActive: true,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    failureReason: null,
    config: { encryptedCredentials: `SYNTHETIC_SOURCE_${id}` },
    rateLimitedUntil: null,
    lastUsedAt: null,
    accountId: '',
    accountEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const remoteRows = [
    makeRow('remote-lantern', 'seed-user', 'lantern_people'),
    makeRow('remote-gpt', 'seed-user', 'gpt_code'),
    makeRow('remote-agentcard', 'seed-user', 'agentcard'),
    makeRow('remote-pooled-lantern', 'foreign-lantern', 'lantern_people', true),
    makeRow('remote-claude', 'pool-owner', 'claude_code', true),
  ];
  type Selection = {
    userId?: string | { not?: string; in?: string[] };
    name?: { in?: string[]; not?: string };
    poolingEnabled?: boolean;
  };
  for (const computeTokensOnly of [false, true]) {
    const dedicated = makeRow('local-lantern', 'seed-user', 'lantern_people');
    dedicated.config = { encryptedCredentials: 'SYNTHETIC_DEDICATED_LOCAL_GRANT' };
    const localRows = new Map<string, Integration>([
      ['seed-user:lantern_people:', dedicated],
      ['seed-user:gpt_code:', makeRow('existing-local-gpt', 'seed-user', 'gpt_code')],
      [
        'pool-owner:claude_code:',
        makeRow('existing-local-claude', 'pool-owner', 'claude_code', true),
      ],
    ]);
    const writes: string[] = [];
    const poolUsers: string[] = [];
    const target: IntegrationModel = {
      upsert: async (args) => {
        const identity = args.where.userId_name_accountId;
        assert(identity !== undefined, 'expected actual compound identity');
        const key = `${identity.userId}:${identity.name}:${identity.accountId}`;
        const existing = localRows.get(key);
        const row = {
          ...(existing ?? args.create),
          ...args.update,
          id: existing?.id ?? `local-${identity.name}`,
        } as Integration;
        localRows.set(key, row);
        writes.push(identity.name);
        return { id: row.id };
      },
    };
    const findProdIntegrations = async (where: Selection) =>
      remoteRows.filter((row) => {
        const user = where.userId;
        return (
          (typeof user !== 'string' || row.userId === user) &&
          (typeof user !== 'object' || user.not === undefined || row.userId !== user.not) &&
          (typeof user !== 'object' || user.in === undefined || user.in.includes(row.userId)) &&
          (where.name?.in === undefined || where.name.in.includes(row.name)) &&
          (where.name?.not === undefined || row.name !== where.name.not) &&
          (where.poolingEnabled === undefined || row.poolingEnabled === where.poolingEnabled)
        );
      });
    const bindings = {
      SEED_USER_ID: 'seed-user',
      COMPUTE_INTEGRATION_NAMES: ['claude_code', 'gpt_code'],
      findProdIntegrations,
      syncIntegrationCredentials,
      remote: { user: {} },
      local: {
        user: {},
        integration: {
          ...target,
          findMany: async () => [],
          updateMany: async () => ({ count: 0 }),
          deleteMany: async (args: { where: { name: { in: string[] } } }) => {
            const names = args.where.name.in;
            assert(
              names.length === 2 &&
                names.includes('claude_code') &&
                names.includes('gpt_code') &&
                !names.includes('lantern_people'),
              'the actual cleanup predicate must preserve dedicated Lantern and non-compute integrations'
            );
            return { count: 0 };
          },
        },
      },
      syncUserRecord: async (_source: unknown, _target: unknown, userId: string) => {
        poolUsers.push(userId);
      },
      integrationPoolIdentity: (row: Integration) =>
        JSON.stringify([row.userId, row.name, row.accountId]),
    };
    const run = new Function(
      ...Object.keys(bindings),
      `let activeRemotePoolIntegrationIds = new Set();\n${executable}\nreturn async options => ({ count: await syncIntegrations(options), pool: [...activeRemotePoolIntegrationIds] });`
    )(...Object.values(bindings)) as (options: {
      computeTokensOnly: boolean;
    }) => Promise<{ count: number; pool: string[] }>;
    const result = await run({ computeTokensOnly });
    assert(
      !writes.includes('lantern_people'),
      'full seed replicated a rotating Lantern grant into the mocked target'
    );
    assert(
      localRows.get('seed-user:lantern_people:') === dedicated,
      'a dedicated local Lantern connection must remain untouched'
    );
    assert(!poolUsers.includes('foreign-lantern'), 'Lantern-only pool owners must not be hydrated');
    assert(
      writes.includes('gpt_code') && writes.includes('claude_code'),
      'compute credentials must still sync'
    );
    assert(
      writes.includes('agentcard') === !computeTokensOnly,
      'ordinary integrations retain full/compute mode behavior'
    );
    assert(
      localRows.get('seed-user:gpt_code:')?.id === 'existing-local-gpt',
      'an existing non-Lantern credential must retain its local primary key'
    );
    assert(
      result.pool.length === 1 && result.pool[0] === 'existing-local-claude',
      'pool source-to-local ID mapping must exclude user rows without shifting its offset'
    );
    assert(
      result.count === (computeTokensOnly ? 2 : 3),
      'counts must include only copied integrations'
    );
  }
});

test('credential writer rejects an entire mixed batch before any rotating-grant copy', async () => {
  const row: Integration = {
    id: 'synthetic-direct-copy',
    userId: 'seed-user',
    name: 'gpt_code',
    poolingEnabled: false,
    type: 'API',
    status: 'CONNECTED',
    isActive: true,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    failureReason: null,
    config: { encryptedCredentials: 'SYNTHETIC_ROTATING_GRANT' },
    rateLimitedUntil: null,
    lastUsedAt: null,
    accountId: '',
    accountEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  let writes = 0;
  const target: IntegrationModel = {
    upsert: async () => {
      writes++;
      return { id: 'target' };
    },
  };
  let rejected = false;
  try {
    await syncIntegrationCredentials(target, [row, { ...row, name: 'lantern_people' }]);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('Lantern');
  }
  assert(rejected, 'direct credential sync must reject a batch containing a Lantern grant');
  assert(
    writes === 0,
    'the whole batch must be validated before even an ordinary credential write'
  );
});

test('AgentCard launcher scopes the missing-Claude opt-out to non-Claude tasks', async () => {
  const source = readSeedLocalSource();
  const launcher = readRepoFile('scripts/run-agentcard-lifecycle-task.sh');
  const tasks = JSON.parse(readRepoFile('agents/benchmarks/tasks.json')) as Array<{
    name: string;
    requires_claude_code: boolean;
  }>;
  const acceptedTasks = [
    'agent-payment-test-shop',
    'agent-payment-setup-resume',
    'agent-payment-idempotent-abandonment',
    'agent-payment-abandonment',
  ];
  const bypass = source.indexOf(
    "process.env.SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK === '1'"
  );
  const warning = source.indexOf('launcher-scoped non-Claude task', bypass);
  // Both providers are inspected up-front; gpt_code must still fail closed
  // after the Claude-only opt-out (do not short-circuit the GPT branch).
  const gptInspection = source.indexOf('await inspectGptCodeIntegrations()');
  const gptFailClosed = source.indexOf(
    "throw new Error('No usable gpt_code integrations after sync')",
    warning
  );

  assert(bypass > 0, 'expected a distinct non-Claude task opt-out');
  assert(warning > bypass, 'expected the opt-out to explain its narrow contract');
  assert(gptInspection > 0, 'expected gpt_code availability to be inspected');
  assert(gptFailClosed > warning, 'expected gpt_code validation to remain active');
  assert(
    launcher.includes('export SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK=1'),
    'expected the AgentCard launcher to opt into the non-Claude task path'
  );
  assert(
    launcher.includes('export SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS=1'),
    'expected the AgentCard launcher to expose dev compute through the isolated pool'
  );
  for (const taskName of acceptedTasks) {
    const task = tasks.find((candidate) => candidate.name === taskName);
    assert(task !== undefined, `expected ${taskName} in the benchmark catalog`);
    assert(
      task.requires_claude_code === false,
      `expected ${taskName} to remain explicitly non-Claude before using the opt-out`
    );
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`FAIL ${name}\n`);
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  process.stdout.write(`\nResults: ${tests.length - failed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
