/** The sidebar's recency key: when a person last messaged an agent. */

import type { Message } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('PersonMessageStamp');

/**
 * Stamp `Agent.lastUserMessageAt` for a message a person sent. Callers pass
 * only person-authored rows, after the row is committed and delivered;
 * agent-authored USER rows (A2A, notifications, compaction, bot alerts) never
 * reach here. One keyed row write per human message; never moves backwards.
 *
 * Raw SQL so `updatedAt` stays put: the liveness reconciler and old-agent
 * collapse read it as "the agent last changed". The timestamp is cast to UTC
 * explicitly because Prisma stores `timestamp(3)` columns in UTC whatever the
 * session time zone. The stamp only orders the sidebar, so a failed write is
 * logged as an error and never fails, retries or duplicates the delivery.
 */
export async function recordPersonMessage(
  message: Pick<Message, 'agentId' | 'timestamp'>
): Promise<void> {
  try {
    const at = message.timestamp.toISOString();
    await prisma.$executeRaw`
      UPDATE "Agent"
      SET "lastUserMessageAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE id = ${message.agentId}
        AND ("lastUserMessageAt" IS NULL
          OR "lastUserMessageAt" < (${at}::timestamptz AT TIME ZONE 'UTC'))`;
  } catch (error) {
    log.error('lastUserMessageAt stamp failed; message delivery unaffected', {
      agent_id: message.agentId,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}
