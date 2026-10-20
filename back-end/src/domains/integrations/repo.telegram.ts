/**
 * Telegram multi-account data access (plan row I8).
 *
 * One Integration row per Telegram account (`name = 'telegram'`, `accountId` =
 * Telegram user id). Its messages are `MessageRecord` rows on channel TELEGRAM
 * with `sourceAccountId` = that id and `externalId` = "<accountId>:<message id>".
 * Legacy single-account rows (`accountId = ''`) own the unattributed rows
 * (`sourceAccountId IS NULL`, plain `externalId`).
 *
 * Every statement here is scoped to ONE user and walks Person(userId) →
 * MessageRecord(personId, channel); nothing scans across users.
 */

import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

type Tx = Prisma.TransactionClient;

export const TELEGRAM_INTEGRATION_NAME = 'telegram';

/**
 * Hand the user's unattributed (legacy) Telegram messages to `accountId`:
 * re-key their dedup id into the account namespace and attribute them. A legacy
 * row whose namespaced twin already exists is a duplicate and is dropped first,
 * so the re-key can never violate the (personId, channel, externalId) key.
 */
export async function adoptLegacyTelegramMessages(
  tx: Tx,
  userId: string,
  accountId: string
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM "MessageRecord" legacy
    USING "Person" person
    WHERE legacy."personId" = person."id"
      AND person."userId" = ${userId}
      AND legacy."channel" = 'TELEGRAM'::"MessageChannel"
      AND legacy."sourceAccountId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "MessageRecord" twin
        WHERE twin."personId" = legacy."personId"
          AND twin."channel" = 'TELEGRAM'::"MessageChannel"
          AND twin."externalId" = ${accountId}::text || ':' || legacy."externalId"
      )`;
  return tx.$executeRaw`
    UPDATE "MessageRecord" record
    SET "sourceAccountId" = ${accountId},
        "externalId" = ${accountId}::text || ':' || record."externalId"
    FROM "Person" person
    WHERE record."personId" = person."id"
      AND person."userId" = ${userId}
      AND record."channel" = 'TELEGRAM'::"MessageChannel"
      AND record."sourceAccountId" IS NULL`;
}

/**
 * Delete one Telegram account row. Returns the database clock at the moment
 * the row was removed (null when it did not exist).
 *
 * Message inserts for an account hold `FOR KEY SHARE` on its row (see
 * personMessageManager), so this DELETE waits for an in-flight insert and every
 * later insert finds no row and stops. `clock_timestamp()` is read after the
 * row lock was acquired, so it bounds every row a committed insert wrote.
 */
export async function deleteTelegramAccountRow(
  userId: string,
  accountId: string
): Promise<Date | null> {
  const rows = await prisma.$queryRaw<Array<{ deletedAt: Date }>>`
    DELETE FROM "Integration"
    WHERE "userId" = ${userId}
      AND "name" = ${TELEGRAM_INTEGRATION_NAME}
      AND "accountId" = ${accountId}
    RETURNING clock_timestamp() AS "deletedAt"`;
  return rows[0]?.deletedAt ?? null;
}

export async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

/**
 * Delete up to `take` Telegram messages of one account (`null` = the legacy
 * unattributed rows) created no later than `notAfter`. Returns rows removed.
 */
export async function deleteTelegramMessageBatch(
  userId: string,
  sourceAccountId: string | null,
  notAfter: Date,
  take: number
): Promise<number> {
  const rows = await prisma.messageRecord.findMany({
    where: {
      person: { userId },
      channel: MessageChannel.TELEGRAM,
      sourceAccountId,
      createdAt: { lte: notAfter },
    },
    select: { id: true },
    take,
  });
  if (rows.length === 0) return 0;
  const result = await prisma.messageRecord.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return result.count;
}

/** Record a failed background upload; a no-op once the account was removed. */
export async function markTelegramUploadFailed(integrationId: string, reason: string) {
  const now = new Date();
  return prisma.integration.updateMany({
    where: { id: integrationId },
    data: {
      status: 'SYNC_FAILED',
      lastSyncAt: now,
      lastFailedSyncAt: now,
      failureReason: reason,
    },
  });
}
