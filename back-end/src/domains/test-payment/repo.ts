import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function resetBenchmarkAgentCardSetup(userId: string): Promise<void> {
  await prisma.integration.deleteMany({ where: { userId, name: 'agentcard' } });
}

export async function completeBenchmarkAgentCardSetup(
  userId: string,
  cardholderId: string
): Promise<void> {
  await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'agentcard' } },
    create: {
      userId,
      name: 'agentcard',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config: { orgManaged: true, cardholderId },
    },
    update: {
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config: { orgManaged: true, cardholderId },
      lastUsedAt: new Date(),
    },
  });
}

export async function findLatestPurchaseLifecycleByAgentId(agentId: string) {
  return prisma.purchaseSpend.findFirst({
    where: { agentId },
    include: { walletFunding: true },
    // `id` is a stable secondary key so ties on createdAt (concurrent inserts)
    // still resolve to a single deterministic row.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Sanitized cardinality proof so a latest-row lifecycle cannot hide older payment orphans. */
export async function findPurchaseLifecycleIntegrityByAgentId(agentId: string) {
  const purchases = await prisma.purchaseSpend.findMany({
    where: { agentId },
    select: {
      cardId: true,
      stripePaymentIntentId: true,
      walletFunding: { select: { id: true } },
    },
  });
  return {
    purchaseCount: purchases.length,
    walletFundingCount: purchases.filter((purchase) => purchase.walletFunding !== null).length,
    stripePaymentIntentCount: new Set(
      purchases.flatMap((purchase) =>
        purchase.stripePaymentIntentId === null || purchase.stripePaymentIntentId === ''
          ? []
          : [purchase.stripePaymentIntentId]
      )
    ).size,
    cardCount: new Set(
      purchases.flatMap((purchase) =>
        purchase.cardId === null || purchase.cardId === '' ? [] : [purchase.cardId]
      )
    ).size,
  };
}

export async function findAttentionRequestsByAgentId(agentId: string) {
  return prisma.agentAttentionRequest.findMany({
    where: { agentId },
    select: { id: true, userResponse: true, metadata: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Owner (userId) of an agent, for authorizing lifecycle reads/mutations. */
export async function findAgentOwnerId(agentId: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { userId: true },
  });
  return agent?.userId ?? null;
}
