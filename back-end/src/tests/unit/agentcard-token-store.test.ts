#!/usr/bin/env tsx
/**
 * Unit tests for the AgentCard token/PKCE store (`providers/agentcard/store.ts`)
 * and its Prisma persistence layer (`providers/agentcard/repo.ts`).
 *
 * Covers the full connect lifecycle against the live local Postgres: PKCE state
 * round-trips, per-user token (de)serialization, org-onboarding config, cardholder
 * promotion, connected-config gating, and token clearing.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { TokenSet } from '../../providers/agentcard/oauth';
import * as agentCardRepo from '../../providers/agentcard/repo';
import {
  clearUserToken,
  getOrgManagedCardholderId,
  getOrgOnboardingConfig,
  getUserToken,
  putPendingAuth,
  saveOrgCardholderId,
  saveOrgOnboardingConfig,
  saveUserToken,
  takePendingAuth,
  getV2ConnectedUserId,
  saveV2ConnectedUserId,
} from '../../providers/agentcard/store';

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
  const userId = `agentcard-store-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

function sampleToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: `at_${randomUUID()}`,
    refreshToken: `rt_${randomUUID()}`,
    tokenType: 'bearer',
    expiresAt: Date.now() + 3600_000,
    scope: 'cards:write',
    ...overrides,
  };
}

async function main(): Promise<void> {
  process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_token_store_client';
  process.stdout.write('Running AgentCard token-store unit tests...\n');
  await test('stale legacy onboarding cannot erase a concurrent v2 binding or connected status', async () => {
    const userId = await seedUser();
    let readDone!: () => void;
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const legacy = saveOrgOnboardingConfig(
      userId,
      { sessionId: 'stale', setupUrl: 'https://legacy.invalid' },
      {
        findTokenConfig: async (id) => {
          const snapshot = await agentCardRepo.findTokenConfig(id);
          readDone();
          await gate;
          return snapshot;
        },
        saveIntegrationConfig: agentCardRepo.saveIntegrationConfig,
      }
    );
    await read;
    await saveV2ConnectedUserId(userId, `usr_race_${userId}`);
    releaseRead();
    await legacy;
    assert.equal(await getV2ConnectedUserId(userId), `usr_race_${userId}`);
    const row = await prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    });
    assert.equal(row?.status, 'CONNECTED');
  });
  await test('sandbox/live client identities round-trip and same-client switches remain forbidden', async () => {
    const userId = await seedUser();
    const previous = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
    try {
      process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_sandbox_client';
      await saveV2ConnectedUserId(userId, 'usr_mode_sandbox');
      process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_live_client';
      assert.equal(await getV2ConnectedUserId(userId), undefined);
      await saveV2ConnectedUserId(userId, 'usr_mode_live');
      assert.equal(await getV2ConnectedUserId(userId), 'usr_mode_live');
      await assert.rejects(saveV2ConnectedUserId(userId, 'usr_other_live'), /already bound/);
      process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_sandbox_client';
      assert.equal(await getV2ConnectedUserId(userId), 'usr_mode_sandbox');
      await saveV2ConnectedUserId(userId, 'usr_mode_sandbox');
      process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_live_client';
      assert.equal(await getV2ConnectedUserId(userId), 'usr_mode_live');
      const config = (await agentCardRepo.findTokenConfig(userId)) as Record<string, unknown>;
      assert.deepEqual(config.v2Bindings, {
        unit_sandbox_client: 'usr_mode_sandbox',
        unit_live_client: 'usr_mode_live',
      });
      delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
      assert.equal(
        await getV2ConnectedUserId(userId),
        undefined,
        'optional reads must support legacy MCP-only credentials'
      );
      await assert.rejects(
        saveV2ConnectedUserId(userId, 'usr_missing_credentials'),
        /AGENTCARD_ORG_OAUTH_CLIENT_ID/
      );
    } finally {
      if (previous === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
      else process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = previous;
    }
  });
  await test('all legacy config writers retain v2 ownership under concurrent writes', async () => {
    for (const write of [
      (id: string) => saveOrgCardholderId(id, `ch_${id}`),
      (id: string) => saveUserToken(id, sampleToken()),
      (id: string) =>
        saveOrgOnboardingConfig(id, { sessionId: `s_${id}`, setupUrl: 'https://legacy.invalid' }),
      (id: string) => clearUserToken(id),
    ]) {
      const userId = await seedUser();
      const providerId = `usr_writers_${userId}`;
      await Promise.all([write(userId), saveV2ConnectedUserId(userId, providerId)]);
      const config = (await agentCardRepo.findTokenConfig(userId)) as Record<string, unknown>;
      assert.equal(
        (config.v2Bindings as Record<string, unknown>)[process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID!],
        providerId
      );
    }
  });
  await test('legacy MCP token refresh preserves an exclusive v2 identity', async () => {
    const userId = await seedUser();
    const providerUserId = `usr_${randomUUID()}`;
    await saveV2ConnectedUserId(userId, providerUserId);
    await saveUserToken(userId, sampleToken());
    assert.equal(await getV2ConnectedUserId(userId), providerUserId);
  });

  await test('pending PKCE state is single-use', async () => {
    const state = `state-${randomUUID()}`;
    await putPendingAuth(state, 'user-1', 'verifier-abc');
    const taken = await takePendingAuth(state);
    assert.equal(taken?.userId, 'user-1');
    assert.equal(taken?.verifier, 'verifier-abc');
    assert.equal(await takePendingAuth(state), undefined, 'state must not be reusable');
    assert.equal(await takePendingAuth('never-set'), undefined);
  });

  await test('saveUserToken then getUserToken round-trips the bundle', async () => {
    const userId = await seedUser();
    assert.equal(await getUserToken(userId), undefined, 'no token before connect');
    const token = sampleToken();
    await saveUserToken(userId, token);
    const loaded = await getUserToken(userId);
    assert.equal(loaded?.accessToken, token.accessToken);
    assert.equal(loaded?.refreshToken, token.refreshToken);
    assert.equal(loaded?.tokenType, 'bearer');
    assert.equal(loaded?.expiresAt, token.expiresAt);
    assert.equal(loaded?.scope, 'cards:write');
  });

  await test('getUserToken omits absent optional fields and defaults tokenType', async () => {
    const userId = await seedUser();
    await saveUserToken(userId, {
      accessToken: `at_${randomUUID()}`,
      tokenType: 'bearer',
      expiresAt: Date.now() + 1000,
    });
    const loaded = await getUserToken(userId);
    assert.equal(loaded?.refreshToken, undefined);
    assert.equal(loaded?.scope, undefined);
    assert.equal(loaded?.tokenType, 'bearer');
  });

  await test('malformed persisted config yields undefined', async () => {
    const userId = await seedUser();
    // Write a config with no accessToken via the org-onboarding path (no token fields).
    await saveOrgOnboardingConfig(userId, { sessionId: 's1', setupUrl: 'https://x/setup' });
    assert.equal(await getUserToken(userId), undefined, 'onboarding-only config has no token');
  });

  await test('org onboarding config persists and reads back', async () => {
    const userId = await seedUser();
    assert.equal(await getOrgOnboardingConfig(userId), undefined);
    await saveOrgOnboardingConfig(userId, {
      sessionId: 'sess-1',
      setupUrl: 'https://agentcard/setup/1',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const config = await getOrgOnboardingConfig(userId);
    assert.equal(config?.sessionId, 'sess-1');
    assert.equal(config?.setupUrl, 'https://agentcard/setup/1');
    assert.ok(config?.expiresAt !== undefined);
    // Onboarding without a cardholder id is not yet org-managed for card routing.
    assert.equal(await getOrgManagedCardholderId(userId), undefined);
  });

  await test('saveOrgCardholderId promotes to org-managed and clears onboarding keys', async () => {
    const userId = await seedUser();
    const cardholderId = `ch_test_${randomUUID()}`;
    await saveOrgOnboardingConfig(userId, { sessionId: 'sess-2', setupUrl: 'https://s/2' });
    await saveOrgCardholderId(userId, cardholderId);
    assert.equal(await getOrgManagedCardholderId(userId), cardholderId);
    assert.equal(
      await getOrgOnboardingConfig(userId),
      undefined,
      'onboarding session keys must be removed after promotion'
    );
    const row = await prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    });
    assert.equal(row?.status, IntegrationStatus.CONNECTED);
    assert.equal(row?.isActive, true);
  });

  await test('getOrgManagedCardholderId requires a non-empty cardholder id', async () => {
    const userId = await seedUser();
    await saveOrgOnboardingConfig(userId, { sessionId: 'sess-3', setupUrl: 'https://s/3' });
    // orgManaged is true but cardholderId is blank -> not usable.
    await prisma.integration.update({
      where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
      data: { config: { orgManaged: true, cardholderId: '   ' } },
    });
    assert.equal(await getOrgManagedCardholderId(userId), undefined);
  });

  await test('clearUserToken disconnects the integration', async () => {
    const userId = await seedUser();
    await saveUserToken(userId, sampleToken());
    await clearUserToken(userId);
    assert.equal(await getUserToken(userId), undefined);
    const row = await prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    });
    assert.equal(row?.status, IntegrationStatus.NOT_CONNECTED);
    assert.equal(row?.isActive, false);
    // getOrgManagedCardholderId gates on CONNECTED+active, so a cleared row is not org-managed.
    assert.equal(await getOrgManagedCardholderId(userId), undefined);
  });

  await test('clearUserToken is a no-op when there is no row', async () => {
    const userId = await seedUser();
    await clearUserToken(userId); // must not throw
    assert.equal(await getUserToken(userId), undefined);
  });

  process.stdout.write(
    `\nAgentCard token-store unit tests: ${passed} passed, ${failures.length} failed\n`
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
