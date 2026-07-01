import { prisma } from '../../providers/database';

/**
 * Fetch agent notification context.
 * Returns { deletedAt, goal } or null if not found.
 */
export async function findAgentDeletedStatus(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { deletedAt: true, goal: true },
  });
}
