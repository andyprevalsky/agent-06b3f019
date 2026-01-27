import { MessageChannel } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

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
 * Transform WhatsApp contact data to the shared ContactToUpsert format
 */
function transformToContactToUpsert(contact: WhatsAppContactWithMessages): ContactToUpsert {
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
    messages: contact.messages.map(msg => ({
      channel: MessageChannel.WHATSAPP,
      from: msg.is_from_me ? 'me' : (msg.contactHandle || contactId),
      to: msg.is_from_me ? (msg.contactHandle || contactId) : 'me',
      timestamp: new Date(msg.date),
      message: msg.text,
      externalId: msg.id, // WhatsApp message key.id for deduplication
    })),
  };
}

export async function parseWhatsAppData(
  userId: string,
  contacts: WhatsAppContactWithMessages[],
  jobId: string
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
  console.log(`[Job ${jobId}] Processing ${totalMessages} WhatsApp messages from ${sanitizedContacts.length} contacts for user ${userId}`);
  if (skippedContacts > 0) {
    console.log(`[Job ${jobId}] Skipped ${skippedContacts} contacts due to missing handles or messages`);
  }

  const integration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'whatsapp' } },
  });

  if (!integration) {
    throw new Error('WhatsApp integration not found');
  }

  // Transform to shared format and call the manager
  const contactsToUpsert = sanitizedContacts.map(transformToContactToUpsert);
  const result = await upsertPersonAndMessageRecords(userId, contactsToUpsert, jobId);

  // Update Integration metadata
  const existingConfig = (integration.config as any) || {};
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...existingConfig,
        lastUploadedAt: new Date().toISOString(),
        totalMessagesProcessed: (existingConfig.totalMessagesProcessed || 0) + totalMessages,
        batchesReceived: (existingConfig.batchesReceived || 0) + 1,
      },
    },
  });

  console.log(`[Job ${jobId}] WhatsApp sync complete: ${result.contacts} contacts, ${result.messages} messages`);
}
