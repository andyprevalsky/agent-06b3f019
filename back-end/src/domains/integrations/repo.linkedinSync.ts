import { prisma } from '../../providers/database';

/** The export agent's lifecycle fields, scoped to its owner. */
export async function findOwnedAgentLifecycle(agentId: string, userId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId },
    select: { status: true, deletedAt: true, temporalWorkflowId: true, createdAt: true },
  });
}

/** The user's current `linkedin` integration row, if any. */
export async function findLinkedInIntegration(userId: string) {
  return prisma.integration.findFirst({
    where: { userId, name: 'linkedin', accountId: '' },
    select: { status: true, config: true },
  });
}
