/**
 * messaging-core: service layer
 *
 * Pure, framework-free business logic that converts NormalizedMessage batches
 * from every platform (iMessage / WhatsApp / Telegram) into the
 * ContactWithMessages shape the backend expects, plus a batch stats helper.
 *
 * Callers: iMessageSync.ts, WhatsAppSync, TelegramSync, the messaging-core
 * blackbox, and the public barrel.
 *
 * Import rule: service may import own types + own config only. No providers,
 * no repo here — this is a pure transform.
 */

import { APPLE_EPOCH_OFFSET_SECONDS } from './config';
import type {
  ContactAccumulator,
  ContactWithMessages,
  MessageBatchStats,
  MessageChannel,
  NormalizedMessage,
} from './types';

/**
 * Convert Date to Apple timestamp (nanoseconds since 2001-01-01) for iMessage
 * or Unix timestamp in milliseconds for other platforms.
 */
function toStorageTimestamp(date: Date, channel: MessageChannel): number {
  if (channel === 'IMESSAGE') {
    const unixSeconds = Math.floor(date.getTime() / 1000);
    return (unixSeconds - APPLE_EPOCH_OFFSET_SECONDS) * 1_000_000_000;
  }
  // For WhatsApp and Telegram, use Unix timestamp in milliseconds
  return date.getTime();
}

/**
 * Fill a string field on `existing` from `incoming` only if `incoming` is a
 * non-empty string and `existing` is still undefined. "First truthy wins"
 * — preserves the pre-refactor MessageTransformer semantics.
 */
function fillStringField<K extends keyof ContactAccumulator>(
  existing: ContactAccumulator,
  key: K,
  incoming: string | undefined
): void {
  if (
    incoming !== undefined &&
    incoming !== '' &&
    (existing[key] as string | undefined) === undefined
  ) {
    (existing[key] as string) = incoming;
  }
}

/**
 * Merge contact enrichment from a later message into an existing accumulator
 * without overwriting values already present. First truthy value wins.
 */
function mergeContactEnrichment(existing: ContactAccumulator, msg: NormalizedMessage): void {
  fillStringField(existing, 'contactName', msg.contactName);
  const contact = msg.contact;
  if (contact === undefined) {
    return;
  }
  fillStringField(existing, 'firstName', contact.firstName);
  fillStringField(existing, 'lastName', contact.lastName);
  fillStringField(existing, 'company', contact.company);
  fillStringField(existing, 'title', contact.title);
  fillStringField(existing, 'email', contact.email);
  const emails = contact.emailAddresses;
  if (
    emails !== undefined &&
    emails.length > 0 &&
    (existing.emailAddresses === undefined || existing.emailAddresses.length === 0)
  ) {
    existing.emailAddresses = emails;
  }
}

/**
 * Group a normalized message batch by contactId, collapsing enrichment per
 * contact. The accumulator's "first truthy wins" mirrors the pre-refactor
 * MessageTransformer semantics exercised by the messaging-core blackbox.
 */
function groupByContact(messages: NormalizedMessage[]): Map<string, ContactAccumulator> {
  const contactMap = new Map<string, ContactAccumulator>();

  for (const msg of messages) {
    const existing = contactMap.get(msg.contactId);
    if (existing !== undefined) {
      existing.messages.push(msg);
      mergeContactEnrichment(existing, msg);
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

  return contactMap;
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
    const contactMap = groupByContact(messages);
    const result: ContactWithMessages[] = [];

    for (const [contactId, data] of contactMap) {
      // Sort messages by timestamp ascending
      const sortedMessages = data.messages.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      result.push({
        contact_id: contactId,
        contact_name: data.contactName ?? null,
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
  static getStats(messages: NormalizedMessage[]): MessageBatchStats {
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
