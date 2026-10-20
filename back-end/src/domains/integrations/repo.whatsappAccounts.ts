/**
 * Data removal for ONE WhatsApp account (plan row I2).
 *
 *   MessageRecord.sourceAccountId  = the linked phone that synced the row
 *                                    (NULL = legacy single-account history)
 *   Person.createdBySource         = `whatsapp:<phone>` when a WhatsApp sync created it
 *
 * Every query is scoped to one user and walks that user's WhatsApp rows in
 * bounded id batches, so cost scales with the deleted account, not the table.
 */

import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { WHATSAPP_CONTACT_SOURCE_PREFIX } from '../../services/integrations/whatsappParser';

const DELETE_BATCH = 1_000;

/**
 * Delete the account's WhatsApp messages: rows attributed to `accountId`, plus
 * the unattributed legacy rows when `includeLegacy`. Returns the count and the
 * contacts those rows belonged to.
 */
export async function deleteWhatsAppAccountMessages(
  userId: string,
  accountId: string | null,
  includeLegacy: boolean
): Promise<{ messages: number; personIds: string[] }> {
  const owned: Prisma.MessageRecordWhereInput[] = [];
  if (accountId !== null) owned.push({ sourceAccountId: accountId });
  if (includeLegacy) owned.push({ sourceAccountId: null });
  const personIds = new Set<string>();
  let messages = 0;
  let batchFull = owned.length > 0;
  while (batchFull) {
    const rows = await prisma.messageRecord.findMany({
      where: { person: { userId }, channel: MessageChannel.WHATSAPP, OR: owned },
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
