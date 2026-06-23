import type { MessageChannel } from '@prisma/client';
import { prisma } from '../../providers/database';

/**
 * Fetch recent INBOUND messages (`to = 'me'`) for a user, newest first.
 *
 * Used by the browser agent's OTP relay. The `since` window (typically the last
 * ~10 minutes) is the selective filter and is served by the
 * `MessageRecord_channel_timestamp_idx` composite index when a channel is
 * supplied, falling back to the `timestamp` index otherwise.
 */
export async function findRecentInboundMessages(params: {
  userId: string;
  since: Date;
  limit: number;
  channel?: MessageChannel;
}) {
  const { userId, since, limit, channel } = params;
  return prisma.messageRecord.findMany({
    where: {
      person: { userId },
      to: 'me',
      timestamp: { gte: since },
      ...(channel !== undefined ? { channel } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
    select: {
      id: true,
      channel: true,
      from: true,
      to: true,
      timestamp: true,
      message: true,
      personId: true,
    },
  });
}

/** Create a new iMessage queue entry. */
export async function createQueueEntry(
  userId: string,
  agentId: string,
  phoneNumber: string,
  message: string
) {
  return prisma.imessageQueue.create({
    data: {
      userId,
      agentId,
      phoneNumber,
      message,
    },
  });
}

/** Pop (find + delete) the oldest pending iMessage for a user, atomically.
 *  Uses FOR UPDATE SKIP LOCKED to prevent concurrent pops from grabbing the same row.
 */
export async function popOldestForUser(userId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        userId: string;
        agentId: string;
        phoneNumber: string;
        message: string;
        createdAt: Date;
      }>
    >(
      `SELECT * FROM "ImessageQueue" WHERE "userId" = $1 ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      userId
    );

    if (rows.length === 0) {
      return null;
    }

    const oldest = rows[0];
    await tx.imessageQueue.delete({
      where: { id: oldest.id },
    });

    return oldest;
  });
}
