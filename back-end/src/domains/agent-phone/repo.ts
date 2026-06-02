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
