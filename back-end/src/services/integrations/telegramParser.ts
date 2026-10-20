import { MessageChannel, Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import {
  MessageAccountRemovedError,
  upsertPersonAndMessageRecords,
  type ContactToUpsert,
} from './personMessageManager';

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

/**
 * The Telegram account (user id) an upload came from and its Integration row.
 * Absent for legacy single-account uploads.
 */
export interface TelegramAccountScope {
  accountId: string;
  integrationId: string;
  accessedAt?: string;
}

/** Account-scoped rows namespace the per-account Telegram message id. */
export function telegramExternalId(messageId: string, accountId?: string): string {
  return accountId === undefined ? messageId : `${accountId}:${messageId}`;
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
function transformToContactToUpsert(
  contact: TelegramContactWithMessages,
  accountId?: string
): ContactToUpsert {
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
      // Telegram message ID for deduplication (namespaced per account).
      externalId: telegramExternalId(msg.id, accountId),
    })),
  };
}

async function findTargetIntegration(userId: string, scope?: TelegramAccountScope) {
  if (scope === undefined) {
    return prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'telegram', accountId: '' } },
    });
  }
  return prisma.integration.findFirst({
    where: { id: scope.integrationId, userId, name: 'telegram', accountId: scope.accountId },
  });
}

function nextConfig(
  existing: Prisma.JsonObject,
  totalMessages: number,
  scope?: TelegramAccountScope
): Prisma.JsonObject {
  const config: Prisma.JsonObject = {
    ...existing,
    lastUploadedAt: new Date().toISOString(),
    totalMessagesProcessed: Number(existing.totalMessagesProcessed ?? 0) + totalMessages,
    batchesReceived: Number(existing.batchesReceived ?? 0) + 1,
  };
  if (scope?.accessedAt !== undefined) config.lastFrontendAccessAt = scope.accessedAt;
  return config;
}

export async function parseTelegramData(
  userId: string,
  contacts: TelegramContactWithMessages[],
  jobId: string,
  scope?: TelegramAccountScope
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

  const integration = await findTargetIntegration(userId, scope);
  if (!integration) {
    if (scope !== undefined) throw new MessageAccountRemovedError();
    throw new Error('Telegram integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map((contact) =>
    transformToContactToUpsert(contact, scope?.accountId)
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

  // Update Integration metadata. `updateMany` keeps this a no-op when the
  // account was removed after its last batch was stored.
  const existingConfig =
    (integration.config as Prisma.JsonObject | null) || ({} as Prisma.JsonObject);
  const now = new Date();
  await prisma.integration.updateMany({
    where: { id: integration.id },
    data: {
      config: nextConfig(existingConfig, totalMessages, scope),
      ...(scope !== undefined && {
        status: 'CONNECTED',
        isActive: true,
        lastSyncAt: now,
        lastSuccessfulSyncAt: now,
        failureReason: null,
      }),
    },
  });

  log.info('Telegram sync complete', {
    jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
}
