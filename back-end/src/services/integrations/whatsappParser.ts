import { MessageChannel, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import {
  ContactToUpsert,
  MessageAccountRemovedError,
  upsertPersonAndMessageRecords,
} from './personMessageManager';

const log = createLogger('WhatsAppParser');

/** `Person.createdBySource` prefix: the contact was created by a WhatsApp account's sync. */
export const WHATSAPP_CONTACT_SOURCE_PREFIX = 'whatsapp:';

export function whatsappContactSource(accountId: string): string {
  return `${WHATSAPP_CONTACT_SOURCE_PREFIX}${accountId}`;
}

/** One linked phone's upload (multi-account Mac app): its Integration row. */
export interface WhatsAppAccountScope {
  accountId: string;
  integrationId: string;
}

/** Account-scoped rows namespace the WhatsApp key.id ("<phone>:<key.id>"), like Telegram. */
export function whatsappExternalId(messageId: string, accountId?: string): string {
  return accountId === undefined ? messageId : `${accountId}:${messageId}`;
}

export interface WhatsAppContactWithMessages {
  contact_id: string;
  contact_name: string | null;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  emailAddresses?: string[];
  messages: WhatsAppMessageData[];
}

export interface WhatsAppMessageData {
  id: string;
  text: string;
  date: number; // Unix timestamp in milliseconds
  is_from_me: boolean;
  contactHandle?: string;
}

const normalizeHandle = (handle?: string | null): string => {
  if (!handle) return '';
  const trimmed = handle.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return '';
  }
  // WhatsApp IDs are phone numbers, ensure they start with +
  if (/^\d+$/.test(trimmed)) {
    return `+${trimmed}`;
  }
  return trimmed;
};

/**
 * Transform WhatsApp contact data to the shared ContactToUpsert format.
 * `accountId` (the linked phone; undefined = legacy single account) marks any
 * contact this upload creates as that WhatsApp account's.
 */
function transformToContactToUpsert(
  contact: WhatsAppContactWithMessages,
  accountId?: string
): ContactToUpsert {
  const contactId = contact.contact_id;
  const isEmail = contactId.includes('@');

  return {
    identifier: contactId,
    identifierType: isEmail ? 'email' : 'phone',
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    title: contact.title,
    email: contact.email,
    emailAddresses: contact.emailAddresses,
    ...(accountId !== undefined && { createdBySource: whatsappContactSource(accountId) }),
    messages: contact.messages.map((msg) => ({
      channel: MessageChannel.WHATSAPP,
      from: msg.is_from_me ? 'me' : msg.contactHandle || contactId,
      to: msg.is_from_me ? msg.contactHandle || contactId : 'me',
      timestamp: new Date(msg.date),
      message: msg.text,
      externalId: whatsappExternalId(msg.id, accountId), // key.id dedup key
    })),
  };
}

export async function parseWhatsAppData(
  userId: string,
  contacts: WhatsAppContactWithMessages[],
  jobId: string,
  scope?: WhatsAppAccountScope
): Promise<void> {
  let skippedContacts = 0;
  const sanitizedContacts = contacts.reduce<WhatsAppContactWithMessages[]>((acc, contact) => {
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
  log.info('Processing WhatsApp messages', {
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

  const integration =
    scope === undefined
      ? await prisma.integration.findUnique({
          where: { userId_name_accountId: { userId, name: 'whatsapp', accountId: '' } },
        })
      : await prisma.integration.findFirst({ where: { id: scope.integrationId, userId } });

  if (!integration) {
    if (scope !== undefined) throw new MessageAccountRemovedError();
    throw new Error('WhatsApp integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map((c) =>
    transformToContactToUpsert(c, scope?.accountId)
  );
  const result = await upsertPersonAndMessageRecords(
    userId,
    contactsToUpsert,
    jobId,
    undefined,
    undefined,
    scope === undefined
      ? undefined
      : { sourceAccountId: scope.accountId, integrationId: scope.integrationId }
  );

  // Update Integration metadata
  const existingConfig =
    (integration.config as Prisma.JsonObject | null) || ({} as Prisma.JsonObject);
  const existingTotalMessages = Number(existingConfig.totalMessagesProcessed ?? 0);
  const existingBatches = Number(existingConfig.batchesReceived ?? 0);
  // `updateMany`: a no-op when the account was removed after this batch was stored.
  await prisma.integration.updateMany({
    where: { id: integration.id },
    data: {
      config: {
        ...existingConfig,
        lastUploadedAt: new Date().toISOString(),
        totalMessagesProcessed: existingTotalMessages + totalMessages,
        batchesReceived: existingBatches + 1,
      },
      ...(scope !== undefined && {
        status: 'CONNECTED',
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        failureReason: null,
      }),
    },
  });

  log.info('WhatsApp sync complete', {
    jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
}
