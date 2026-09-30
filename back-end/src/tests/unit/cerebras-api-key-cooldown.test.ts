#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

async function main(): Promise<void> {
  // The recurring unit runner supplies the workspace database. Direct runs
  // must supply the same local URLs before any dotenv/Prisma module is imported.
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const reason = nonLocalDatabaseReason(process.env[key] ?? '');
    assert.equal(reason, null, `${key} must explicitly identify an owned local test DB`);
  }
  const { prisma } = await import('../../providers/database');
  const { getCerebrasApiKeyCooldown, markCerebrasApiKeyOnCooldown } =
    await import('../../providers/computeCredentials');
  const credentialId = createHash('sha256').update(randomUUID()).digest('hex');
  const model = 'qwen-3.8-27b';
  const identity = {
    userId: '00000000-0000-0000-0000-000000000000',
    name: 'cerebras_api_key_cooldown',
    accountId: `${credentialId}:${model}`,
  };
  try {
    assert.deepEqual(await getCerebrasApiKeyCooldown(credentialId, model), {
      rateLimitedUntil: null,
    });
    const deadlines = [60, 240, 90, 180, 75, 120, 30, 200, 50, 45].map((seconds) =>
      new Date(Date.now() + seconds * 1000).toISOString()
    );
    await Promise.all(
      deadlines.map((until) => markCerebrasApiKeyOnCooldown(credentialId, model, until))
    );
    const maximum = [...deadlines].sort().at(-1);
    assert.equal(
      (await getCerebrasApiKeyCooldown(credentialId, model)).rateLimitedUntil,
      maximum,
      'concurrent creators and shorter resets must preserve the largest expiry'
    );
    await markCerebrasApiKeyOnCooldown(credentialId, model, deadlines[0]);
    assert.equal((await getCerebrasApiKeyCooldown(credentialId, model)).rateLimitedUntil, maximum);
    assert.deepEqual(await getCerebrasApiKeyCooldown(credentialId, 'another-model'), {
      rateLimitedUntil: null,
    });
    assert.deepEqual(await getCerebrasApiKeyCooldown('f'.repeat(64), model), {
      rateLimitedUntil: null,
    });
    await assert.rejects(markCerebrasApiKeyOnCooldown(credentialId, model, 'not-a-date'));
    await assert.rejects(
      markCerebrasApiKeyOnCooldown(credentialId, model, new Date(0).toISOString())
    );
    await assert.rejects(getCerebrasApiKeyCooldown('actual-secret-value', model));
    await assert.rejects(getCerebrasApiKeyCooldown(credentialId, '../invalid-model'));
    process.stdout.write(
      'PASS Cerebras shared cooldown: concurrent maximum, expiry scope and validation\n'
    );
  } finally {
    await prisma.integration.deleteMany({ where: identity });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
