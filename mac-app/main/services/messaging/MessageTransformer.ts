import type { NormalizedMessage, ContactWithMessages, MessageChannel } from './types';

/**
 * Convert Date to Apple timestamp (nanoseconds since 2001-01-01) for iMessage
 * or Unix timestamp in milliseconds for other platforms.
 */
function toStorageTimestamp(date: Date, channel: MessageChannel): number {
  if (channel === 'IMESSAGE') {
    // Apple epoch offset: seconds between Unix epoch (1970) and Apple epoch (2001)
    const APPLE_EPOCH_OFFSET = 978307200;
    const unixSeconds = Math.floor(date.getTime() / 1000);
    return (unixSeconds - APPLE_EPOCH_OFFSET) * 1_000_000_000;
  }
  // For WhatsApp and Telegram, use Unix timestamp in milliseconds
  return date.getTime();
}

/**
 * Single transformer for all messaging platforms.
 * Converts NormalizedMessage[] to ContactWithMessages[] for backend upload.
 */
export class MessageTransformer {
  /**
   * Transform normalized messages to backend ContactWithMessages format.
   * Groups messages by contactId and formats them for the backend API.
   */
  static toContactWithMessages(messages: NormalizedMessage[]): ContactWithMessages[] {
    // Group messages by contactId
    const contactMap = new Map<
      string,
      {
        messages: NormalizedMessage[];
        contactName?: string;
        firstName?: string;
        lastName?: string;
        company?: string;
        title?: string;
        email?: string;
        emailAddresses?: string[];
        channel: MessageChannel;
      }
    >();

    for (const msg of messages) {
      const existing = contactMap.get(msg.contactId);
      if (existing) {
        existing.messages.push(msg);
        // Update contact info if this message has more details
        if (msg.contactName && !existing.contactName) {
          existing.contactName = msg.contactName;
        }
        if (msg.contact) {
          if (msg.contact.firstName && !existing.firstName) {
            existing.firstName = msg.contact.firstName;
          }
          if (msg.contact.lastName && !existing.lastName) {
            existing.lastName = msg.contact.lastName;
          }
          if (msg.contact.company && !existing.company) {
            existing.company = msg.contact.company;
          }
          if (msg.contact.title && !existing.title) {
            existing.title = msg.contact.title;
          }
          if (msg.contact.email && !existing.email) {
            existing.email = msg.contact.email;
          }
          if (msg.contact.emailAddresses?.length && !existing.emailAddresses?.length) {
            existing.emailAddresses = msg.contact.emailAddresses;
          }
        }
      } else {
        contactMap.set(msg.contactId, {
          messages: [msg],
          contactName: msg.contactName,
          firstName: msg.contact?.firstName,
          lastName: msg.contact?.lastName,
          company: msg.contact?.company,
          title: msg.contact?.title,
          email: msg.contact?.email,
          emailAddresses: msg.contact?.emailAddresses,
          channel: msg.channel,
        });
      }
    }

    // Convert to ContactWithMessages array
    const result: ContactWithMessages[] = [];

    for (const [contactId, data] of contactMap) {
      // Sort messages by timestamp ascending
      const sortedMessages = data.messages.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      result.push({
        contact_id: contactId,
        contact_name: data.contactName || null,
        firstName: data.firstName,
        lastName: data.lastName,
        company: data.company,
        title: data.title,
        email: data.email,
        emailAddresses: data.emailAddresses,
        messages: sortedMessages.map((msg) => ({
          id: msg.id,
          text: msg.text,
          date: toStorageTimestamp(msg.timestamp, msg.channel),
          is_from_me: msg.isFromMe,
          contactHandle: contactId,
        })),
      });
    }

    return result;
  }

  /**
   * Get summary statistics for a batch of messages.
   */
  static getStats(messages: NormalizedMessage[]): {
    total: number;
    fromUser: number;
    fromOthers: number;
    uniqueContacts: number;
    byChannel: Record<MessageChannel, number>;
  } {
    const byChannel: Record<MessageChannel, number> = {
      IMESSAGE: 0,
      WHATSAPP: 0,
      TELEGRAM: 0,
    };

    const contactIds = new Set<string>();
    let fromUser = 0;

    for (const msg of messages) {
      byChannel[msg.channel]++;
      contactIds.add(msg.contactId);
      if (msg.isFromMe) {
        fromUser++;
      }
    }

    return {
      total: messages.length,
      fromUser,
      fromOthers: messages.length - fromUser,
      uniqueContacts: contactIds.size,
      byChannel,
    };
  }
}
