import { MessageChannel, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

const log = createLogger('iMessageParser');

const INVALID_HANDLE_SENTINEL = 'unknown';

const normalizeHandle = (handle?: string | null) => {
  if (!handle) return '';
  const trimmed = handle.trim();
  if (!trimmed || trimmed.toLowerCase() === INVALID_HANDLE_SENTINEL) {
    return '';
  }
  return trimmed;
};

export interface ContactWithMessages {
  contact_id: string;
  contact_name: string | null;
  // Contact enrichment data from Contacts DB
  firstName?: string;
  lastName?: string;
  middleName?: string;
  nickname?: string;
  company?: string;
  jobTitle?: string;
  department?: string;
  email?: string;
  emailAddresses?: string[];
  // Messages for this contact
  messages: MessageData[];
}

export interface MessageData {
  id: number;
  text: string;
  date: number;
  is_from_me: boolean;
  contactHandle?: string;
}

function appleTimestampToDate(appleTimestamp: number): Date {
  const APPLE_EPOCH_OFFSET = 978307200;
  const timestampInSeconds = appleTimestamp / 1_000_000_000;
  const unixTimestamp = timestampInSeconds + APPLE_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000);
}

/**
 * Transform iMessage contact data to the shared ContactToUpsert format.
 * Device-account messages (`accountId` set) are keyed `<accountId>:<ROWID>`:
 * ROWIDs are per-Mac, so the same number on two Macs is two messages.
 */
function transformToContactToUpsert(
  contact: ContactWithMessages,
  accountId: string
): ContactToUpsert {
  const contactId = contact.contact_id;
  const isEmail = contactId.includes('@');

  return {
    identifier: contactId,
    identifierType: isEmail ? 'email' : 'phone',
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    title: contact.jobTitle,
    email: contact.email,
    emailAddresses: contact.emailAddresses,
    messages: contact.messages.map((msg) => ({
      channel: MessageChannel.IMESSAGE,
      from: msg.is_from_me ? 'me' : msg.contactHandle || contactId,
      to: msg.is_from_me ? msg.contactHandle || contactId : 'me',
      timestamp: appleTimestampToDate(msg.date),
      message: msg.text,
      // iMessage ROWID for deduplication, namespaced by the Mac it came from.
      externalId: accountId === '' ? String(msg.id) : `${accountId}:${msg.id}`,
    })),
  };
}

/**
 * Store one iMessage upload. `accountId` is the Mac device account
 * (`''` = the legacy single account every older Mac app writes).
 */
export async function parseIMessageData(
  userId: string,
  contacts: ContactWithMessages[],
  jobId: string,
  accountId = ''
): Promise<{ contacts: number; messages: number }> {
  let skippedContacts = 0;
  const sanitizedContacts = contacts.reduce<ContactWithMessages[]>((acc, contact) => {
    const contactId = normalizeHandle(contact.contact_id);
    if (!contactId || !contact.messages?.length) {
      skippedContacts++;
      return acc;
    }
    const normalizedMessages = contact.messages.map((message) => ({
      ...message,
      contactHandle: message.contactHandle ?? contactId,
    }));
    acc.push({
      ...contact,
      contact_id: contactId,
      messages: normalizedMessages,
    });
    return acc;
  }, []);

  const totalMessages = sanitizedContacts.reduce((sum, c) => sum + c.messages.length, 0);
  log.info('Processing iMessage messages', {
    jobId,
    totalMessages,
    contacts: sanitizedContacts.length,
    userId,
  });
  if (skippedContacts > 0) {
    log.info('Skipped contacts due to missing handles or messages', {
      jobId,
      skippedContacts,
    });
  }

  const integration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'imessage', accountId } },
  });

  if (!integration) {
    throw new Error('Integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map((contact) =>
    transformToContactToUpsert(contact, accountId)
  );
  // Device accounts insert under their Integration row (sourceAccountId set, and
  // stopped by MessageAccountRemovedError once that row is deleted).
  const result = await upsertPersonAndMessageRecords(
    userId,
    contactsToUpsert,
    jobId,
    undefined,
    undefined,
    accountId === '' ? undefined : { sourceAccountId: accountId, integrationId: integration.id }
  );

  // Update Integration metadata
  const existingConfig =
    (integration.config as Prisma.JsonObject | null) || ({} as Prisma.JsonObject);
  const existingTotalMessages = Number(existingConfig.totalMessagesProcessed ?? 0);
  const existingBatches = Number(existingConfig.batchesReceived ?? 0);
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...existingConfig,
        lastUploadedAt: new Date().toISOString(),
        totalMessagesProcessed: existingTotalMessages + totalMessages,
        batchesReceived: existingBatches + 1,
      },
    },
  });

  log.info('iMessage sync complete', {
    jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
  return result;
}
