/**
 * messaging-whatsapp: normalization helpers
 *
 * Pure functions that convert Baileys' WAMessage shape into the domain's
 * NormalizedMessage contract. No side effects, no IO. Kept separate from
 * `service.ts` so the client class stays under the strict max-lines cap and
 * the transformation logic is independently verifiable.
 *
 * Typing pragma: Baileys is dynamically imported at runtime (see service.ts),
 * so we can't statically pull in its types in a CommonJS build. We work with
 * a narrow local shape and treat unknown fields defensively.
 */
import type { NormalizedMessage } from './types';

interface WAKey {
  remoteJid?: string | null;
  id?: string | null;
  fromMe?: boolean | null;
  participant?: string | null;
}

interface WABaileysMessage {
  key?: WAKey | null;
  message?: WAMessageContent | null;
  messageTimestamp?: number | string | null;
  pushName?: string | null;
}

interface WAMessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
}

/** Convert a WhatsApp JID to an E.164 phone number, or null if it has no digits. */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (jid === undefined || jid === null || jid === '') return null;
  // JID format: 1234567890:12@s.whatsapp.net or 1234567890@s.whatsapp.net
  const match = jid.match(/^(\d+)/);
  return match !== null ? `+${match[1]}` : null;
}

/** Extract readable text content from a WAMessage, or null if none is usable. */
export function extractMessageText(msg: WABaileysMessage): string | null {
  const message = msg.message;
  if (message === undefined || message === null) return null;

  if (typeof message.conversation === 'string' && message.conversation !== '') {
    return message.conversation;
  }
  const extText = message.extendedTextMessage?.text;
  if (typeof extText === 'string' && extText !== '') return extText;

  const imgCap = message.imageMessage?.caption;
  if (typeof imgCap === 'string' && imgCap !== '') return imgCap;

  const vidCap = message.videoMessage?.caption;
  if (typeof vidCap === 'string' && vidCap !== '') return vidCap;

  const docCap = message.documentMessage?.caption;
  if (typeof docCap === 'string' && docCap !== '') return docCap;

  return null;
}

/** True when a remoteJid is a status/broadcast pseudo-chat that should be skipped. */
export function isSkippableJid(remoteJid: string | null | undefined): boolean {
  if (remoteJid === undefined || remoteJid === null || remoteJid === '') return true;
  return remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast');
}

/**
 * Normalize a Baileys WAMessage to the domain's NormalizedMessage.
 * Returns null when the message has no usable text or no resolvable contactId.
 */
export function normalizeMessage(msg: WABaileysMessage): NormalizedMessage | null {
  const key = msg.key;
  if (
    key === undefined ||
    key === null ||
    key.remoteJid === undefined ||
    key.remoteJid === null ||
    key.remoteJid === '' ||
    key.id === undefined ||
    key.id === null ||
    key.id === ''
  ) {
    return null;
  }

  const text = extractMessageText(msg);
  if (text === null) return null; // Skip media-only messages for now

  // Group JIDs end with @g.us
  const isGroup = key.remoteJid.endsWith('@g.us');
  const participantJid = key.participant;
  const senderJid = isGroup ? participantJid : key.remoteJid;

  const contactId = jidToPhone(senderJid ?? key.remoteJid);
  if (contactId === null) return null;

  const timestamp =
    msg.messageTimestamp !== undefined && msg.messageTimestamp !== null
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : new Date();

  return {
    id: key.id,
    text,
    timestamp,
    isFromMe: key.fromMe === true,
    chatId: key.remoteJid,
    contactId,
    contactName: typeof msg.pushName === 'string' && msg.pushName !== '' ? msg.pushName : undefined,
    channel: 'WHATSAPP',
  };
}

/**
 * Normalize a batch of raw Baileys messages, dropping ones with no usable
 * remoteJid (status/broadcast), no text, or no resolvable contactId.
 */
export function normalizeBatch(messages: readonly WABaileysMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const msg of messages) {
    if (isSkippableJid(msg.key?.remoteJid)) continue;
    const normalized = normalizeMessage(msg);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

export type { WABaileysMessage };
