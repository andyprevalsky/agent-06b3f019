import { IntegrationStatus, IntegrationType, PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function resetBenchmarkAgentCardSetup(userId: string): Promise<void> {
  await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    create: {
      userId,
      name: 'agentcard',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.NOT_CONNECTED,
      isActive: true,
      config: {},
    },
    update: {
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.NOT_CONNECTED,
      isActive: true,
      // Preserve v2 ownership and legacy credentials for cleanup; only readiness changes.
      lastUsedAt: new Date(),
    },
  });
}

export async function findLatestPurchaseLifecycleByAgentId(agentId: string) {
  // Prefer AgentCard-funded rows over later structured-output GMV stubs
  // (`provider: order_confirmation`). A completion harvest that records the wrong
  // amount/merchant must not shadow the real payment lifecycle used by benches.
  const agentCardPurchase = await prisma.purchaseSpend.findFirst({
    where: {
      agentId,
      OR: [
        { cardId: { not: null } },
        { stripePaymentIntentId: { not: null } },
        { walletFunding: { isNot: null } },
        { provider: 'agentcard' },
      ],
    },
    include: { walletFunding: true },
    // `id` is a stable secondary key so ties on createdAt (concurrent inserts)
    // still resolve to a single deterministic row.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (agentCardPurchase !== null) return agentCardPurchase;
  return prisma.purchaseSpend.findFirst({
    where: { agentId },
    include: { walletFunding: true },
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

/**
 * HELD lifecycle-probe purchases for one user, with the agent that owns each.
 *
 * Scoped to the $1 probe cart so the harness preflight can only clear holds
 * belonging to that probe -- never an unrelated real purchase.
 */
export async function findHeldLifecycleProbePurchases(
  userId: string,
  totalCents: number
): Promise<Array<{ id: string; agentId: string | null }>> {
  return prisma.purchaseSpend.findMany({
    where: {
      userId,
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
      totalCents,
    },
    select: { id: true, agentId: true },
  });
}

/** Immutable billing snapshots for every exact-agent intent, including failed setup attempts. */
export async function findStripePurchasesByAgentId(agentId: string) {
  return prisma.purchaseSpend.findMany({
    where: { agentId, stripePaymentIntentId: { not: null } },
    select: {
      id: true,
      userId: true,
      agentId: true,
      status: true,
      totalCents: true,
      stripePaymentIntentId: true,
      stripeLivemode: true,
      stripeCustomerId: true,
    },
    orderBy: { id: 'asc' },
    take: 101,
  });
}
