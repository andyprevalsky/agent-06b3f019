#!/usr/bin/env tsx
/**
 * Integration ↔ ComputeAccountConnection chip sync blackbox tests.
 *
 * Guards the bridge that flips FE chips to needs_reconnect when runtime
 * Integration rows die with auth_error, while rate limits stay silent.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import { markGptUserTokenRateLimited } from '../../providers/gptCredentials';
import { markUserTokenRateLimited } from '../../providers/claudeCredentials';
import { reconcileConnectionStatesFromIntegrations } from '../../providers/integrationConnectionSync';
import { upsertAccountConnection } from '../../domains/compute-grants/repo';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const RUN = randomUUID().slice(0, 8);
const userId = `ics-user-${RUN}`;
const claudeAccountId = `claude-acct-${RUN}`;
const gptAccountId = `gpt-acct-${RUN}`;
const createdIntegrationIds: string[] = [];

async function cleanup() {
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.computeAccountConnection.deleteMany({ where: { userId } });
}

async function seedIntegration(params: {
  name: 'claude_code' | 'gpt_code';
  accountId: string;
  accountEmail: string;
}) {
  const row = await prisma.integration.create({
    data: {
      userId,
      name: params.name,
      accountId: params.accountId,
      accountEmail: params.accountEmail,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      config: { encryptedCredentials: 'placeholder' },
    },
  });
  createdIntegrationIds.push(row.id);
  return row;
}

test('auth_error on Claude integration flips matching chip to needs_reconnect', async () => {
  await seedIntegration({
    name: 'claude_code',
    accountId: claudeAccountId,
    accountEmail: 'claude@example.com',
  });
  await upsertAccountConnection({
    userId,
    provider: 'claude',
    accountId: claudeAccountId,
    accountEmail: 'claude@example.com',
  });

  await markUserTokenRateLimited(userId, {
    failureReason: 'auth_error',
    accountId: claudeAccountId,
  });

  const chip = await prisma.computeAccountConnection.findFirst({
    where: { userId, provider: 'claude', accountId: claudeAccountId },
  });
  assert(chip?.state === 'needs_reconnect', `expected needs_reconnect, got ${chip?.state}`);
  assert(chip?.lastErrorReason === 'auth_error', 'chip must carry auth_error reason');
});

test('auth_error on GPT integration flips matching chip to needs_reconnect', async () => {
  await seedIntegration({
    name: 'gpt_code',
    accountId: gptAccountId,
    accountEmail: 'gpt@example.com',
  });
  await upsertAccountConnection({
    userId,
    provider: 'codex',
    accountId: gptAccountId,
    accountEmail: 'gpt@example.com',
  });

  await markGptUserTokenRateLimited(userId, {
    failureReason: 'auth_error',
    accountId: gptAccountId,
  });

  const chip = await prisma.computeAccountConnection.findFirst({
    where: { userId, provider: 'codex', accountId: gptAccountId },
  });
  assert(chip?.state === 'needs_reconnect', `expected needs_reconnect, got ${chip?.state}`);
  assert(chip?.lastErrorReason === 'auth_error', 'chip must carry auth_error reason');
});

test('rate limit alone must not flip chip to needs_reconnect', async () => {
  const integration = await seedIntegration({
    name: 'claude_code',
    accountId: `${claudeAccountId}-rate`,
    accountEmail: 'rate@example.com',
  });
  await upsertAccountConnection({
    userId,
    provider: 'claude',
    accountId: `${claudeAccountId}-rate`,
    accountEmail: 'rate@example.com',
  });

  await markUserTokenRateLimited(userId, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    accountId: `${claudeAccountId}-rate`,
    integrationId: integration.id,
  });

  const chip = await prisma.computeAccountConnection.findFirst({
    where: { userId, provider: 'claude', accountId: `${claudeAccountId}-rate` },
  });
  assert(chip?.state === 'connected', `rate limit must not flip chip, got ${chip?.state}`);
});

test('reconcile repairs EXPIRED/auth_error drift without touching rate-limited rows', async () => {
  const driftAccountId = `${claudeAccountId}-drift`;
  await prisma.integration.create({
    data: {
      userId,
      name: 'claude_code',
      accountId: driftAccountId,
      accountEmail: 'drift@example.com',
      type: 'TOOL_SETUP',
      status: 'EXPIRED',
      isActive: false,
      failureReason: 'auth_error',
      config: { encryptedCredentials: 'placeholder' },
    },
  });
  await upsertAccountConnection({
    userId,
    provider: 'claude',
    accountId: driftAccountId,
    accountEmail: 'drift@example.com',
  });

  const healthyAccountId = `${claudeAccountId}-healthy-rate`;
  await prisma.integration.create({
    data: {
      userId,
      name: 'claude_code',
      accountId: healthyAccountId,
      accountEmail: 'healthy@example.com',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      rateLimitedUntil: new Date(Date.now() + 60_000),
      failureReason: null,
      config: { encryptedCredentials: 'placeholder' },
    },
  });
  await upsertAccountConnection({
    userId,
    provider: 'claude',
    accountId: healthyAccountId,
    accountEmail: 'healthy@example.com',
  });

  await reconcileConnectionStatesFromIntegrations(userId);

  const driftChip = await prisma.computeAccountConnection.findFirst({
    where: { userId, provider: 'claude', accountId: driftAccountId },
  });
  assert(
    driftChip?.state === 'needs_reconnect',
    `drift chip must reconcile to needs_reconnect, got ${driftChip?.state}`
  );

  const healthyChip = await prisma.computeAccountConnection.findFirst({
    where: { userId, provider: 'claude', accountId: healthyAccountId },
  });
  assert(
    healthyChip?.state === 'connected',
    `rate-limited healthy integration must stay connected, got ${healthyChip?.state}`
  );
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await cleanup();
      await fn();
      console.log(`✓ ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err instanceof Error ? err.message : err);
      failed += 1;
    }
  }
  await cleanup();
  console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
