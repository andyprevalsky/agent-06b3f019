/**
 * iMessage device-account message storage (plan row I1).
 *
 * MessageRecord has no userId: a user's iMessage rows are reached through
 * Person(userId) → MessageRecord(personId, channel) — both indexed — and are
 * selected by `sourceAccountId` (null = the legacy single account). Every
 * statement touches at most BATCH rows, so one account's delete or adoption
 * never holds a long transaction (10k rule: work is O(that account's rows)).
 */

import { prisma } from '../../providers/database';

const BATCH = 5_000;

async function repeatUntilShort(step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const changed = await step();
    total += changed;
    if (changed < BATCH) return total;
  }
}

/** Delete one account's iMessage rows (`null` = legacy, device-less rows). Returns rows deleted. */
export async function deleteIMessagesForAccount(
  userId: string,
  sourceAccountId: string | null
): Promise<number> {
  return repeatUntilShort(() =>
    sourceAccountId === null
      ? prisma.$executeRaw`
          DELETE FROM "MessageRecord" WHERE "id" IN (
            SELECT m."id" FROM "MessageRecord" m
            JOIN "Person" p ON p."id" = m."personId"
            WHERE p."userId" = ${userId} AND m."channel" = 'IMESSAGE'
              AND m."sourceAccountId" IS NULL
            LIMIT ${BATCH})`
      : prisma.$executeRaw`
          DELETE FROM "MessageRecord" WHERE "id" IN (
            SELECT m."id" FROM "MessageRecord" m
            JOIN "Person" p ON p."id" = m."personId"
            WHERE p."userId" = ${userId} AND m."channel" = 'IMESSAGE'
              AND m."sourceAccountId" = ${sourceAccountId}
            LIMIT ${BATCH})`
  );
}

/**
 * Re-key the legacy (device-less) iMessage rows as this Mac's: sourceAccountId
 * set and externalId `<accountId>:<ROWID>`, the key its device uploads use, so
 * re-uploading the same chat.db rows dedups instead of duplicating them. A
 * legacy row whose device key already exists is a duplicate and is removed.
 */
export async function adoptLegacyIMessages(userId: string, accountId: string): Promise<number> {
  const adopted = await repeatUntilShort(
    () => prisma.$executeRaw`
      UPDATE "MessageRecord" m SET
        "sourceAccountId" = ${accountId},
        "externalId" = CASE WHEN m."externalId" IS NULL THEN NULL
                            ELSE ${accountId} || ':' || m."externalId" END
      WHERE m."id" IN (
        SELECT l."id" FROM "MessageRecord" l
        JOIN "Person" p ON p."id" = l."personId"
        WHERE p."userId" = ${userId} AND l."channel" = 'IMESSAGE'
          AND l."sourceAccountId" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "MessageRecord" d
            WHERE d."personId" = l."personId" AND d."channel" = l."channel"
              AND d."externalId" = ${accountId} || ':' || l."externalId")
        LIMIT ${BATCH})`
  );
  await repeatUntilShort(
    () => prisma.$executeRaw`
      DELETE FROM "MessageRecord" WHERE "id" IN (
        SELECT l."id" FROM "MessageRecord" l
        JOIN "Person" p ON p."id" = l."personId"
        WHERE p."userId" = ${userId} AND l."channel" = 'IMESSAGE'
          AND l."sourceAccountId" IS NULL
          AND EXISTS (
            SELECT 1 FROM "MessageRecord" d
            WHERE d."personId" = l."personId" AND d."channel" = l."channel"
              AND d."externalId" = ${accountId} || ':' || l."externalId")
        LIMIT ${BATCH})`
  );
  return adopted;
}
