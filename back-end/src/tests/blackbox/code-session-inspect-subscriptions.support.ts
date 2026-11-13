import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

type InspectionIntegration = Pick<PrismaClient['integration'], 'findMany'>;

/** This funded-key fixture has no subscription logins, including shared pools. */
export function beginIsolatedInspectionSubscriptions(
  integration: InspectionIntegration
): () => void {
  const original = integration.findMany;
  const query = original.bind(integration);
  integration.findMany = ((args) => {
    const name = args?.where?.name;
    if (name === 'claude_code' || name === 'gpt_code') return Promise.resolve([]);
    return query(args);
  }) as typeof integration.findMany;
  return () => {
    integration.findMany = original;
  };
}

export async function assertInspectionSubscriptionIsolation(): Promise<void> {
  let delegated = 0;
  const original = (async () => {
    delegated += 1;
    return [];
  }) as InspectionIntegration['findMany'];
  const integration = { findMany: original };
  const finish = beginIsolatedInspectionSubscriptions(integration);
  try {
    for (const name of ['claude_code', 'gpt_code']) {
      assert.deepEqual(await integration.findMany({ where: { name, poolingEnabled: true } }), []);
      assert.deepEqual(await integration.findMany({ where: { name, userId: 'fixture-only' } }), []);
    }
    assert.equal(delegated, 0, 'subscription enumeration never reads the shared delegate');
    await integration.findMany({ where: { name: 'unrelated-fixture' } });
    assert.equal(delegated, 1, 'unrelated queries retain their original delegate');
  } finally {
    finish();
  }
  assert.equal(integration.findMany, original, 'the exact original delegate is restored');
  await integration.findMany({ where: { name: 'gpt_code', poolingEnabled: true } });
  assert.equal(delegated, 2, 'restoration restores the original query behavior');
}
