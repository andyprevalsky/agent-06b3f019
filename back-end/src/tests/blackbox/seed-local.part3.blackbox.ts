#!/usr/bin/env tsx

// Overflow from seed-local.part2.blackbox.ts (max-lines). Compute-token any-mode,
// synthetic pool, and AgentCard launcher opt-out source invariants.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
