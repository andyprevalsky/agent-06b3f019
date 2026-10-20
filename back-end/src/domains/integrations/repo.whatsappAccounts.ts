/**
 * Data access for ONE WhatsApp account (plan row I2).
 *
 *   MessageRecord.sourceAccountId  = the linked phone that synced the row
 *                                    (NULL = legacy single-account history);
 *                                    such rows namespace externalId "<phone>:<key.id>"
 *   Person.createdBySource         = `whatsapp:<phone>` when a WhatsApp sync created it
 *
 * Every query is scoped to one user and walks that user's WhatsApp rows in
 * bounded id batches, so cost scales with the account, not the table.
 */

import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { WHATSAPP_CONTACT_SOURCE_PREFIX } from '../../services/integrations/whatsappParser';

type Tx = Prisma.TransactionClient;

const DELETE_BATCH = 1_000;
export const WHATSAPP_INTEGRATION_NAME = 'whatsapp';

/**
 * Inside the legacy-row claim: the legacy history came from this phone, so
 * attribute it (namespaced like new rows) and its WhatsApp-only contacts.
 * A legacy row whose namespaced twin already exists is a duplicate and goes.
 */
export async function adoptLegacyWhatsAppMessages(
  tx: Tx,
  userId: string,
  accountId: string
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM "MessageRecord" legacy
    USING "Person" person
    WHERE legacy."personId" = person."id"
      AND person."userId" = ${userId}
      AND legacy."channel" = 'WHATSAPP'::"MessageChannel"
      AND legacy."sourceAccountId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "MessageRecord" twin
        WHERE twin."personId" = legacy."personId"
          AND twin."channel" = 'WHATSAPP'::"MessageChannel"
          AND twin."externalId" = ${accountId}::text || ':' || legacy."externalId"
      )`;
  // Legacy contacts keep `createdBySource = NULL`: nothing records which source
  // created them, so a later account delete keeps them (never another source's).
  return tx.$executeRaw`
    UPDATE "MessageRecord" record
    SET "sourceAccountId" = ${accountId},
        "externalId" = ${accountId}::text || ':' || record."externalId"
    FROM "Person" person
    WHERE record."personId" = person."id"
      AND person."userId" = ${userId}
      AND record."channel" = 'WHATSAPP'::"MessageChannel"
      AND record."sourceAccountId" IS NULL`;
}

/** Delete one account's Integration row; resolves whether it existed. */
export async function deleteWhatsAppAccountRow(userId: string, accountId: string) {
  const deleted = await prisma.integration.deleteMany({
    where: { userId, name: WHATSAPP_INTEGRATION_NAME, accountId },
  });
  return deleted.count > 0;
}

/**
 * Delete the account's WhatsApp messages (`accountId = null`: the legacy
 * unattributed rows). Returns the count and the contacts they belonged to.
 */
export async function deleteWhatsAppAccountMessages(
  userId: string,
  accountId: string | null
): Promise<{ messages: number; personIds: string[] }> {
  const personIds = new Set<string>();
  let messages = 0;
  let batchFull = true;
  while (batchFull) {
    const rows = await prisma.messageRecord.findMany({
      where: { person: { userId }, channel: MessageChannel.WHATSAPP, sourceAccountId: accountId },
      select: { id: true, personId: true },
      take: DELETE_BATCH,
    });
    for (const row of rows) personIds.add(row.personId);
    if (rows.length > 0) {
      const deleted = await prisma.messageRecord.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      messages += deleted.count;
    }
    batchFull = rows.length === DELETE_BATCH;
  }
  return { messages, personIds: [...personIds] };
}

/**
 * Delete contacts a WhatsApp sync created that no message references any more.
 * Contacts another source created (Contacts/VCF, LinkedIn, Gmail…) or that still
 * have messages from another account or channel are kept.
 */
export async function deleteOrphanedWhatsAppContacts(
  userId: string,
  personIds: string[]
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < personIds.length; i += DELETE_BATCH) {
    const deleted = await prisma.person.deleteMany({
      where: {
        id: { in: personIds.slice(i, i + DELETE_BATCH) },
        userId,
        createdBySource: { startsWith: WHATSAPP_CONTACT_SOURCE_PREFIX },
        messageRecords: { none: {} },
      },
    });
    removed += deleted.count;
  }
  return removed;
}
