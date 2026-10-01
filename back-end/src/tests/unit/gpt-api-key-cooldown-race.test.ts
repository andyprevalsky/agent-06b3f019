#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import {
  __clearGptApiKeyCooldownCache,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from '../../providers/gptCredentials';
import { prisma } from '../../providers/database';

async function main(): Promise<void> {
  const integration = prisma.integration as unknown as {
    findUnique: (...args: unknown[]) => Promise<unknown>;
    upsert: (...args: unknown[]) => Promise<unknown>;
  };
  const originalFindUnique = integration.findUnique;
  const originalUpsert = integration.upsert;
  let finishRead!: (row: { rateLimitedUntil: Date | null } | null) => void;
  let readCount = 0;
  integration.findUnique = async () => {
    readCount++;
    return new Promise((resolve) => {
      finishRead = resolve;
    });
  };
  integration.upsert = async () => ({});

  try {
    __clearGptApiKeyCooldownCache();
    const staleRead = isGptApiKeyOnCooldown();
    await markGptApiKeyOnCooldown('insufficient_quota');
    finishRead(null);
    assert.equal(await staleRead, true, 'older DB read must preserve the new local cooldown');
    assert.equal(await isGptApiKeyOnCooldown(), true, 'the next request must skip the funded key');
    assert.equal(readCount, 1);
    process.stdout.write('GPT API key cooldown: stale DB read cannot clear a new local mark\n');
  } finally {
    integration.findUnique = originalFindUnique;
    integration.upsert = originalUpsert;
    __clearGptApiKeyCooldownCache();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
