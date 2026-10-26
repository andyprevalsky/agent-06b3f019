import type { MessageChannel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';

const IMESSAGE_QUEUE_TRANSACTION_BUDGET_MS = 15_000;

/**
 * Fetch recent INBOUND messages (`to = 'me'`) for a user, newest first.
 *
 * Used by the browser agent's OTP relay. The `since` window (typically the last
 * ~10 minutes) is the selective filter and is served by the
 * `MessageRecord(userId, timestamp)` index.
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
      userId,
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
  message: string,
  id?: string,
  expiresAt?: Date
) {
  if (id !== undefined) {
    return prisma.imessageQueue.upsert({
      where: { id },
      update: {},
      create: {
        id,
        userId,
        agentId,
        phoneNumber,
        message,
        expiresAt,
      },
    });
  }
  return prisma.imessageQueue.create({
    data: {
      userId,
      agentId,
      phoneNumber,
      message,
      expiresAt,
    },
  });
}

/** Take the oldest pending iMessage for a user, atomically.
 *
 * Acknowledgement-capable clients receive a lease token. Legacy clients retain
 * their historical one-shot pop behavior: the row is terminally marked as
 * dispatched (rather than deleted) so it cannot be resent and the idempotency
 * receipt survives. Uses FOR UPDATE SKIP LOCKED to prevent concurrent claims.
 */
export async function popOldestForUser(userId: string, supportsAcknowledgements: boolean) {
  return runTransactionWithRetry(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          userId: string;
          agentId: string;
          phoneNumber: string;
          message: string;
          createdAt: Date;
          expiresAt: Date | null;
          claimedAt: Date | null;
          claimToken: string | null;
          dispatchedAt: Date | null;
          sentAt: Date | null;
          failedAt: Date | null;
          lastError: string | null;
          attempts: number;
          failures: number;
        }>
      >(
        `SELECT * FROM "ImessageQueue"
       WHERE "userId" = $1
         AND "sentAt" IS NULL
         AND "failedAt" IS NULL
         AND "dispatchedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
         AND ("claimedAt" IS NULL OR "claimedAt" < NOW() - INTERVAL '2 minutes')
       ORDER BY "createdAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
        userId
      );

      if (rows.length === 0) {
        return null;
      }

      const oldest = rows[0];
      const claimToken = supportsAcknowledgements ? randomUUID() : null;
      await tx.imessageQueue.update({
        where: { id: oldest.id },
        data: supportsAcknowledgements
          ? {
              claimedAt: new Date(),
              claimToken,
              attempts: { increment: 1 },
            }
          : {
              dispatchedAt: new Date(),
              claimedAt: null,
              claimToken: null,
              attempts: { increment: 1 },
            },
      });

      return { ...oldest, claimToken };
    },
    {
      maxWait: IMESSAGE_QUEUE_TRANSACTION_BUDGET_MS,
      timeout: IMESSAGE_QUEUE_TRANSACTION_BUDGET_MS,
    }
  );
}

/** Record a result for the current lease only. Failed sends are released for
 * retry until the third reported send failure, independent of lease expiry. */
export async function recordQueueDeliveryResult(params: {
  userId: string;
  id: string;
  claimToken: string;
  success: boolean;
  error?: string;
}) {
  return runTransactionWithRetry(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ claimToken: string | null; failures: number }>>(
        `SELECT "claimToken", "failures" FROM "ImessageQueue"
       WHERE "id" = $1 AND "userId" = $2
       FOR UPDATE`,
        params.id,
        params.userId
      );
      const row = rows[0];
      if (row === undefined) return { kind: 'not_found' as const };
      if (row.claimToken !== params.claimToken) return { kind: 'stale_claim' as const };

      if (params.success) {
        const entry = await tx.imessageQueue.update({
          where: { id: params.id },
          data: {
            sentAt: new Date(),
            claimedAt: null,
            claimToken: null,
            lastError: null,
          },
        });
        return { kind: 'recorded' as const, entry };
      }

      const failures = row.failures + 1;
      const terminal = failures >= 3;
      const entry = await tx.imessageQueue.update({
        where: { id: params.id },
        data: {
          claimedAt: null,
          claimToken: null,
          failures,
          failedAt: terminal ? new Date() : null,
          lastError: params.error ?? 'Mac sender failed',
        },
      });
      return { kind: 'recorded' as const, entry };
    },
    {
      maxWait: IMESSAGE_QUEUE_TRANSACTION_BUDGET_MS,
      timeout: IMESSAGE_QUEUE_TRANSACTION_BUDGET_MS,
    }
  );
}

export async function findQueueEntryForUser(userId: string, id: string) {
  return prisma.imessageQueue.findFirst({ where: { id, userId } });
}

export async function markImessageBridgeSeen(userId: string, seenAt: Date) {
  return prisma.user.updateMany({
    where: { userId },
    data: { imessageBridgeLastSeenAt: seenAt },
  });
}

export async function findImessageBridgeLastSeen(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: { imessageBridgeLastSeenAt: true },
  });
}
