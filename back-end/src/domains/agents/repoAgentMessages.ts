/**
 * Agent-to-agent message reads: tree membership and task inbox (tree
 * navigation lives in repoAgentTree.ts).
 *
 * Every query is keyed by indexed columns (Agent.id, Agent.busId,
 * Message(agentId, timestamp)) and bounded, so cost scales with the one
 * agent/tree being acted on rather than with the number of agents overall.
 */

import { prisma } from '../../providers/database';

export const AGENT_INBOX_MAX_MESSAGES = 100;

/** Sender + target membership facts in one primary-key lookup. */
export async function findAgentsForTreeAuth(agentIds: string[]) {
  return prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: {
      id: true,
      userId: true,
      busId: true,
      goal: true,
      status: true,
      deletedAt: true,
      temporalWorkflowId: true,
      backgroundTasks: true,
      parentAgentId: true,
      taskPath: true,
    },
  });
}

/** Agent messages addressed to one task owned by `agentId`, oldest first. */
export async function findTaskInboxMessages(agentId: string, taskId: string, since?: Date) {
  return prisma.message.findMany({
    where: {
      agentId,
      ...(since !== undefined ? { timestamp: { gt: since } } : {}),
      role: 'USER',
      AND: [
        { metadata: { path: ['agentMessage'], equals: true } },
        { metadata: { path: ['recipientTaskId'], equals: taskId } },
      ],
    },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    take: AGENT_INBOX_MAX_MESSAGES,
    select: { id: true, text: true, metadata: true, timestamp: true },
  });
}
