/**
 * Tool-usage domain repo — all Prisma calls for tool usage tracking.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

/**
 * Find an agent by ID, returning only id and userId.
 */
export async function findAgentById(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true },
  });
}

/**
 * Create a tool usage record.
 */
export async function createToolUsage(params: {
  userId: string;
  agentId: string;
  toolName: string;
  totalCostCents: number;
  usageItems: Prisma.InputJsonValue;
}) {
  return prisma.toolUsage.create({
    data: {
      userId: params.userId,
      agentId: params.agentId,
      toolName: params.toolName,
      totalCostCents: params.totalCostCents,
      usageItems: params.usageItems,
    },
  });
}

/**
 * Get all tool usage records for an agent, ordered by creation time ascending.
 */
export async function findToolUsagesByAgentId(agentId: string) {
  return prisma.toolUsage.findMany({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
  });
}
