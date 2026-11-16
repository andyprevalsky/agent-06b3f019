import { prisma } from '../../providers/database';

/** Only the fields a public link preview may show; never goal internals, cost or results. */
export function findAgentPreviewRow(agentId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: { title: true, goal: true, status: true },
  });
}
