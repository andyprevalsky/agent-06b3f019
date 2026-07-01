import type { AgentStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function upsertUser(userId: string) {
  return prisma.user.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function upsertSubscription(params: {
  userId: string;
  subscriptionTier: number;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  currentPeriodEnd: Date;
}) {
  return prisma.subscription.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      subscriptionTier: params.subscriptionTier,
      stripeSubscriptionId: params.stripeSubscriptionId,
      stripeCustomerId: params.stripeCustomerId,
      currentPeriodEnd: params.currentPeriodEnd,
    },
    update: {
      subscriptionTier: params.subscriptionTier,
      stripeSubscriptionId: params.stripeSubscriptionId,
      currentPeriodEnd: params.currentPeriodEnd,
    },
  });
}

export async function createCredit(params: {
  userId: string;
  amountCents: number;
  expirationDate: Date;
}) {
  return prisma.credit.create({
    data: {
      userId: params.userId,
      amountCents: params.amountCents,
      expirationDate: params.expirationDate,
    },
  });
}

export async function findPausedAgents(userId: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      status: 'PAUSED',
      deletedAt: null,
    },
  });
}

export async function findActiveAgents(userId: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      deletedAt: null,
    },
  });
}

export async function updateAgentStatus(agentId: string, status: AgentStatus) {
  return prisma.agent.update({
    where: { id: agentId },
    data: { status },
  });
}

/** Resolve the local user behind a Stripe subscription (renewal/cancel events carry the sub id). */
export async function findSubscriptionByStripeSubscriptionId(stripeSubscriptionId: string) {
  return prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
}

/** Remove a user's subscription record (revoke). Re-subscribe re-creates it via handlePaymentSuccess. */
export async function deleteSubscriptionByUserId(userId: string) {
  return prisma.subscription.deleteMany({ where: { userId } });
}
