import { prisma } from '../../providers/database';

/**
 * Check if an agent has been soft-deleted.
 * Returns { deletedAt } or null if not found.
 */
export async function findAgentDeletedStatus(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { deletedAt: true },
  });
}
