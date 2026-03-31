import { prisma } from '../../providers/database';

export async function findUserById(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
  });
}

export async function createUser(userId: string) {
  return prisma.user.create({
    data: { userId },
  });
}

export async function findSubscriptionByUserId(userId: string) {
  return prisma.subscription.findUnique({
    where: { userId },
  });
}

export async function findAgentTokenStatsByUserId(userId: string) {
  return prisma.agent.findMany({
    where: { userId },
    select: {
      model: true,
      tokenCount: true,
      tokensIn: true,
      tokensOut: true,
    },
  });
}
