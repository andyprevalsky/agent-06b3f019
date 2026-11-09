/** Normal owned-root lookup for idempotent existing-iPhone setup starts. */
import { prisma } from '../../providers/database';
export function ownedSetupAgent(agentId: string, userId: string) {
  return prisma.agent.findFirst({ where: { id: agentId, userId, deletedAt: null } });
}
export function firstSetupGoal(agentId: string) {
  return prisma.message.findFirst({
    where: { agentId, role: 'USER' },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
}
