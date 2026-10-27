/** Owner-scoped persistence reads for canonical descendant stopping. */
import { prisma } from '../../providers/database';

export function findKillParent(id: string, userId: string) {
  return prisma.agent.findFirst({ where: { id, userId }, select: { parentAgentId: true } });
}
export function findKillRows(ids: string[], userId: string) {
  return prisma.agent.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, temporalWorkflowId: true },
  });
}
export function findKillChildren(ids: string[], userId: string) {
  return prisma.agent.findMany({
    where: { userId, parentAgentId: { in: ids } },
    select: { id: true },
  });
}
export function countKillResources(ids: string[]) {
  return Promise.all([
    prisma.browserSession.count({ where: { agentId: { in: ids }, status: { not: 'CLOSED' } } }),
    prisma.claudeCodeSession.count({ where: { agentId: { in: ids }, status: { not: 'CLOSED' } } }),
  ]);
}
export function requireKillParent(id: string, userId: string) {
  return prisma.agent.findFirstOrThrow({ where: { id, userId }, select: { parentAgentId: true } });
}
export function findKillSiblings(id: string, userId: string, parentAgentId: string | null) {
  return prisma.agent.findMany({
    where: { userId, parentAgentId, id: { not: id }, deletedAt: null },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
    take: 21,
  });
}
