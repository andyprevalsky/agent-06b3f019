/** The sidebar's recency key: when a person last messaged an agent. */

import type { Message, Prisma } from '@prisma/client';
import { prisma } from './database';

/**
 * Stamp `Agent.lastUserMessageAt` for a message a person sent. Callers pass only
 * person-authored rows; agent-authored USER rows (A2A, notifications,
 * compaction) never reach here. One keyed row write per human message; the
 * stamp never moves backwards.
 */
export async function recordPersonMessage(
  message: Pick<Message, 'agentId' | 'timestamp'>,
  tx?: Prisma.TransactionClient
): Promise<void> {
  await (tx ?? prisma).agent.updateMany({
    where: {
      id: message.agentId,
      OR: [{ lastUserMessageAt: null }, { lastUserMessageAt: { lt: message.timestamp } }],
    },
    data: { lastUserMessageAt: message.timestamp },
  });
}
