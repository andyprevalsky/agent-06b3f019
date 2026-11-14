#!/usr/bin/env tsx
/**
 * Unit tests for benchmark AgentCard setup toggles in test-payment/service.ts.
 * Split from test-payment-service.test.ts to stay under max-lines.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { configureBenchmarkAgentCardSetup } from '../../domains/test-payment/service';
import { prepareBenchmarkAgentCardResidual } from '../../domains/test-payment/benchmarkResidual';

const createdUserIds: string[] = [];
let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

async function seedUser(): Promise<string> {
  const userId = `test-payment-agentcard-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function main(): Promise<void> {
  process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_payment_fixture_client';
  await test('v2 sandbox setup completes, resets and restores the exclusive connected user', async () => {
    const userId = await seedUser();
    const providerId = `usr_fixture_${randomUUID()}`;
    const requests: string[] = [];
    const deps = {
      getV2FixtureUserId: () => providerId,
      v2Request: async (_method: string, resource: string) => {
        requests.push(resource);
        return resource.endsWith('company_wallet')
          ? { livemode: false, default_funds_source: 'company_flow' }
          : { status: 'pending' };
      },
    };
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ action: 'complete' }, deps),
      /userId is required/
    );
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ userId, action: 'nonsense' }, deps),
      /action must be reset, complete, or prepare-residual/
    );
    assert.equal(
      (await configureBenchmarkAgentCardSetup({ userId, action: 'complete' }, deps)).status,
      'connected'
    );
    const key = { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } };
    const row = await prisma.integration.findUnique({ where: key });
    assert.equal((row?.config as Record<string, unknown>).v2UserId, providerId);
    assert.equal((row?.config as Record<string, unknown>).cardholderId, undefined);
    await prisma.integration.update({
      where: key,
      data: {
        config: {
          ...(row?.config as Record<string, unknown>),
          cardholderId: 'legacy_cleanup',
          accessToken: 'legacy_cleanup_token',
        },
      },
    });
    assert.equal(
      (await configureBenchmarkAgentCardSetup({ userId, action: 'reset' }, deps)).status,
      'connect_required'
    );
    const reset = await prisma.integration.findUnique({ where: key });
    assert.equal(reset?.status, 'NOT_CONNECTED');
    assert.deepEqual(reset?.config, {
      ...(row?.config as Record<string, unknown>),
      cardholderId: 'legacy_cleanup',
      accessToken: 'legacy_cleanup_token',
    });
    await configureBenchmarkAgentCardSetup({ userId, action: 'complete' }, deps);
    assert.equal((await prisma.integration.findUnique({ where: key }))?.status, 'CONNECTED');
    assert(
      requests.every((path) => path.startsWith('/api/v2/')),
      'setup toggles must never call MCP'
    );
  });

  await test('v2 fixture setup refuses live credentials, missing mapping and production toggles', async () => {
    const userId = await seedUser();
    await assert.rejects(
      configureBenchmarkAgentCardSetup(
        { userId, action: 'complete' },
        {
          getV2FixtureUserId: () => undefined,
          v2Request: async () => {
            throw new Error('missing mapping must not call provider');
          },
        }
      ),
      /BENCHMARK_AGENTCARD_V2_USER_ID/
    );
    await assert.rejects(
      configureBenchmarkAgentCardSetup(
        { userId, action: 'complete' },
        {
          getV2FixtureUserId: () => 'usr_fixture_live',
          v2Request: async () => ({ livemode: true, default_funds_source: 'company_flow' }),
        }
      ),
      /sandbox credentials/
    );
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const action of ['complete', 'reset'])
        await assert.rejects(
          configureBenchmarkAgentCardSetup(
            { userId, action },
            {
              v2Request: async () => {
                throw new Error('production toggle must not call provider');
              },
            }
          ),
          /Sandbox AgentCard setup unavailable/
        );
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
    assert.equal(await prisma.integration.count({ where: { userId } }), 0);
  });

  await test('sandbox payment setup sweeps only the resolved cardholder before a mint', async () => {
    const recovered: string[] = [];
    const ready = await prepareBenchmarkAgentCardResidual({
      resolveCardholderId: async () => 'cardholder-resolved',
      recoverCardholderResidual: async (cardholderId) => {
        recovered.push(cardholderId);
        return { status: 'completed', amountCents: 4396 };
      },
    });
    assert.equal(ready.status, 'residual_ready');
    assert.deepEqual(recovered, ['cardholder-resolved']);
    await assert.rejects(
      () =>
        prepareBenchmarkAgentCardResidual({
          resolveCardholderId: async () => 'cardholder-resolved',
          recoverCardholderResidual: async () => ({ status: 'requested', amountCents: 4396 }),
        }),
      /not yet settled/
    );
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        () =>
          prepareBenchmarkAgentCardResidual({
            resolveCardholderId: async () => 'cardholder-resolved',
            recoverCardholderResidual: async () => {
              throw new Error('production recovery must never run');
            },
          }),
        /Sandbox residual preparation unavailable/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  process.stdout.write(
    `\nTest-payment AgentCard setup unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
