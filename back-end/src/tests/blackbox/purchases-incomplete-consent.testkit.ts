/** Owning lookup regression for incomplete requested and persisted consent receipts. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PurchaseSpendStatus } from '@prisma/client';
import * as purchasesService from '../../domains/purchases/service';
import { prisma } from '../../providers/database';
import { assert, StubCardStateProvider } from './purchases.testkit';

const users = new Set<string>();
async function createUser(label: string): Promise<string> {
  const userId = `incomplete-consent-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  users.add(userId);
  return userId;
}
async function createAgent(userId: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'incomplete consent regression' },
  });
  return agent.id;
}

export async function testIncompleteConsentCannotGrantReuse(): Promise<void> {
  const cases = JSON.parse(
    readFileSync(
      new URL('../fixtures/approval-reuse-incomplete-consent.json', import.meta.url),
      'utf8'
    )
  );
  assert(cases.length === 5, 'incomplete-consent owning batch must remain frozen at five cases');
  const failures: string[] = [];
  try {
    for (const example of cases) {
      const userId = await createUser(example.id);
      const agentId = await createAgent(userId);
      const fingerprint = `incomplete-consent-${randomUUID()}`;
      const held = await prisma.purchaseSpend.create({
        data: {
          userId,
          agentId,
          fingerprint,
          canonicalFingerprint: fingerprint,
          merchant: example.approved.merchant,
          lineItemsJson: example.approved,
          totalCents: example.approved.totalCents,
          status: PurchaseSpendStatus.HELD,
          cardId: `held-${randomUUID()}`,
        },
      });
      let calls = 0;
      const result = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
        userId,
        fingerprint,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: example.approved.totalCents }),
        new Date(),
        { ...example.requested, userId, agentId, fingerprint },
        async () => {
          calls += 1;
          return null;
        },
      ]);
      const expected = example.expectedPurchaseId !== null;
      const outcome =
        result.reusable === expected ? (expected ? 'TP' : 'TN') : result.reusable ? 'FP' : 'FN';
      console.log(`INCOMPLETE_CONSENT_BOUNDARY ${example.id} ${outcome} semanticCalls=${calls}`);
      if (
        result.reusable !== expected ||
        calls !== example.expectedSemanticCalls ||
        (expected && result.purchase?.id !== held.id)
      )
        failures.push(`${example.id}: ${outcome}, semanticCalls=${calls}`);
    }
    assert(
      failures.length === 0,
      `Incomplete receipt cannot establish consent: ${failures.join('; ')}`
    );
  } finally {
    for (const userId of users) {
      await prisma.agent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
    users.clear();
  }
}
