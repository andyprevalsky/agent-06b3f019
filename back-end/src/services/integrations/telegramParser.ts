import { MessageChannel, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

const log = createLogger('TelegramParser');

export interface TelegramContactWithMessages {
  contact_id: string;
  contact_name: string | null;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  emailAddresses?: string[];
  messages: TelegramMessageData[];
}

export interface TelegramMessageData {
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
  return trimmed;
};

/**
 * Transform Telegram contact data to the shared ContactToUpsert format
 */
function transformToContactToUpsert(contact: TelegramContactWithMessages): ContactToUpsert {
  const contactId = contact.contact_id;
  // Telegram IDs are typically numeric user IDs
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
    messages: contact.messages.map((msg) => ({
      channel: MessageChannel.TELEGRAM,
      from: msg.is_from_me ? 'me' : msg.contactHandle || contactId,
      to: msg.is_from_me ? msg.contactHandle || contactId : 'me',
      timestamp: new Date(msg.date),
      message: msg.text,
      externalId: msg.id, // Telegram message ID for deduplication
    })),
  };
}

export async function parseTelegramData(
  userId: string,
  contacts: TelegramContactWithMessages[],
  jobId: string
): Promise<void> {
  let skippedContacts = 0;
  const sanitizedContacts = contacts.reduce<TelegramContactWithMessages[]>((acc, contact) => {
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
  log.info('Processing Telegram messages', {
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
    where: { userId_name_accountId: { userId, name: 'telegram', accountId: '' } },
  });

  if (!integration) {
    throw new Error('Telegram integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map(transformToContactToUpsert);
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

  log.info('Telegram sync complete', {
    jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
}
