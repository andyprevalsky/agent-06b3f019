#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import { prisma } from '../../providers/database';
import {
  __resetCodexFundedCooldown,
  codexFundedCooldownUntil,
  markCodexFundedCooldown,
} from '../../providers/codeSessions/usageLimit';
import {
  __clearGptApiKeyCooldownCache,
  __resetGptApiKeyCooldown,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from '../../providers/gptCredentials';
import { withIsolatedFundedKeyCooldowns } from '../blackbox/funded-key-cooldown.support';

const integration = prisma.integration as unknown as {
  findUnique: (...args: unknown[]) => Promise<unknown>;
  upsert: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Stand in for the shared local database while another process holds both
 * funded keys cooled, the state a deploy stack leaves after OpenAI answers 402.
 */
async function withLiveSharedCooldowns(
  fn: (shared: { writes: string[]; otherReads: number }) => Promise<void>
): Promise<void> {
  const real = {
    findUnique: integration.findUnique,
    upsert: integration.upsert,
    deleteMany: integration.deleteMany,
  };
  const shared = { writes: [] as string[], otherReads: 0 };
  integration.findUnique = async (...args: unknown[]) => {
    const where = (args[0] as { where?: { userId_name_accountId?: unknown } }).where;
    if (where?.userId_name_accountId === undefined) {
      shared.otherReads++;
      return null;
    }
    return { rateLimitedUntil: new Date(Date.now() + 30 * 60 * 1000) };
  };
  integration.upsert = async () => {
    shared.writes.push('upsert');
    return {};
  };
  integration.deleteMany = async () => {
    shared.writes.push('deleteMany');
    return { count: 1 };
  };
  try {
    await fn(shared);
  } finally {
    integration.findUnique = real.findUnique;
    integration.upsert = real.upsert;
    integration.deleteMany = real.deleteMany;
    __clearGptApiKeyCooldownCache();
  }
}

async function testIsolatedCasesNeitherInheritNorClearSharedCooldowns(): Promise<void> {
  await withLiveSharedCooldowns(async (shared) => {
    __clearGptApiKeyCooldownCache();
    assert.equal(await isGptApiKeyOnCooldown(), true, 'fixture: the shared GPT row is live');

    const sharedFindUnique = integration.findUnique;
    await withIsolatedFundedKeyCooldowns(async () => {
      assert.equal(await isGptApiKeyOnCooldown(), false, 'a live shared GPT mark leaked in');
      assert.equal(
        await isAnthropicApiKeyOnCooldown(),
        false,
        'a live shared Anthropic mark leaked in'
      );
      assert.equal(await codexFundedCooldownUntil(), null, 'a live shared Codex mark leaked in');

      await markGptApiKeyOnCooldown('insufficient_quota');
      __clearGptApiKeyCooldownCache();
      assert.equal(await isGptApiKeyOnCooldown(), true, 'an in-process GPT mark must persist');
      await __resetGptApiKeyCooldown();
      assert.equal(await isGptApiKeyOnCooldown(), false, 'an in-process GPT reset must clear');

      await markAnthropicApiKeyOnCooldown('out_of_credits');
      assert.equal(await isAnthropicApiKeyOnCooldown(), true);
      await __resetAnthropicApiKeyCooldown();
      assert.equal(await isAnthropicApiKeyOnCooldown(), false);

      const reset = new Date(Date.now() + 60_000);
      await markCodexFundedCooldown(reset);
      assert.deepEqual(await codexFundedCooldownUntil(), reset, 'a private Codex mark persists');
      await __resetCodexFundedCooldown();
      assert.equal(await codexFundedCooldownUntil(), null, 'a private Codex reset clears');

      await prisma.integration.findUnique({ where: { id: 'unrelated-integration' } });
    });

    assert.deepEqual(shared.writes, [], 'an isolated case wrote or deleted a shared cooldown row');
    assert.equal(shared.otherReads, 1, 'unrelated integration reads must reach the database');
    assert.equal(integration.findUnique, sharedFindUnique, 'the delegate was not restored');
    __clearGptApiKeyCooldownCache();
    assert.equal(await isGptApiKeyOnCooldown(), true, 'the shared GPT mark must survive');
    assert.ok(await codexFundedCooldownUntil(), 'the shared Codex mark must survive');
    await assert.rejects(
      withIsolatedFundedKeyCooldowns(async () => {
        throw new Error('fixture failure');
      }),
      /fixture failure/
    );
    assert.equal(integration.findUnique, sharedFindUnique, 'a failed scope restores the delegate');
  });
}

testIsolatedCasesNeitherInheritNorClearSharedCooldowns()
  .then(() => {
    process.stdout.write('PASS funded-key cooldown isolation\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
