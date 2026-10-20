import { MessageChannel, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

const log = createLogger('WhatsAppParser');

/** `Person.createdBySource` prefix: the contact was created by a WhatsApp account's sync. */
export const WHATSAPP_CONTACT_SOURCE_PREFIX = 'whatsapp:';

export function whatsappContactSource(accountId: string): string {
  return `${WHATSAPP_CONTACT_SOURCE_PREFIX}${accountId}`;
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
 * `accountId` (the linked phone; '' = legacy single account) attributes the
 * messages and any contact this upload creates to that WhatsApp account.
 */
function transformToContactToUpsert(
  contact: WhatsAppContactWithMessages,
  accountId: string
): ContactToUpsert {
  const contactId = contact.contact_id;
  const isEmail = contactId.includes('@');
  const attributed = accountId !== '';

  return {
    identifier: contactId,
    identifierType: isEmail ? 'email' : 'phone',
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    title: contact.title,
    email: contact.email,
    emailAddresses: contact.emailAddresses,
    ...(attributed && { createdBySource: whatsappContactSource(accountId) }),
    messages: contact.messages.map((msg) => ({
      channel: MessageChannel.WHATSAPP,
      from: msg.is_from_me ? 'me' : msg.contactHandle || contactId,
      to: msg.is_from_me ? msg.contactHandle || contactId : 'me',
      timestamp: new Date(msg.date),
      message: msg.text,
      externalId: msg.id, // WhatsApp message key.id for deduplication
      ...(attributed && { sourceAccountId: accountId }),
    })),
  };
}

export async function parseWhatsAppData(
  userId: string,
  contacts: WhatsAppContactWithMessages[],
  jobId: string,
  accountId = ''
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

  const integration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'whatsapp', accountId } },
  });

  if (!integration) {
    throw new Error('WhatsApp integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map((c) => transformToContactToUpsert(c, accountId));
  const result = await upsertPersonAndMessageRecords(userId, contactsToUpsert, jobId);

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

  log.info('WhatsApp sync complete', {
    jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
}
