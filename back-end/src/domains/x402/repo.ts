import { prisma } from '../../providers/database';
import { RECENT_MESSAGES_LIMIT } from './config';

/**
 * Find a non-deleted agent by ID with status-relevant fields.
 */
export async function findAgentById(agentId: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    select: {
      id: true,
      goal: true,
      model: true,
      status: true,
      statusMessage: true,
      progress: true,
      tokenCount: true,
      tokensIn: true,
      tokensOut: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
    },
  });
}

/**
 * Fetch the most recent messages for an agent (chronological order).
 */
export async function findRecentMessages(agentId: string) {
  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'desc' },
    take: RECENT_MESSAGES_LIMIT,
    select: {
      role: true,
      text: true,
      timestamp: true,
    },
  });
  return messages.reverse(); // Chronological order
}
