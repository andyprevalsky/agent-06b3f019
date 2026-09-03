import { prisma } from '../../providers/database';

export async function findAgentIdentityForMessages(userId: string) {
  return prisma.agentIdentity.findUnique({
    where: { userId },
    select: {
      phone: true,
      phoneProvider: true,
      phoneProviderAgentId: true,
      phoneProviderNumberId: true,
    },
  });
}

/** True when `agentId` is an agent owned by `userId` (not soft-deleted). */
export async function isAgentOwnedByUser(userId: string, agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId, deletedAt: null },
    select: { id: true },
  });
  return agent !== null;
}
