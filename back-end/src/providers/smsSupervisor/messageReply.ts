import { prisma } from '../database';
import type { SupervisorChannel } from './channelDelivery';
export interface QuotedMessage {
  role: 'user' | 'assistant';
  content: string;
}
type ReplyTargetResult =
  | { ok: true; replyToMessageId?: string; quotedMessage?: QuotedMessage }
  | { ok: false; error: string };

/** Append-only session positions keep older texts without provider IDs replyable. */
function replyId(message: Record<string, unknown>, index: number): string {
  return typeof message.providerMessageId === 'string' && message.providerMessageId.trim() !== ''
    ? message.providerMessageId
    : `session-message:${index + 1}`;
}

/** Resolve only IDs from this user's conversation; never search other users. */
export async function resolveReplyTarget(
  userId: string,
  channel: SupervisorChannel,
  rawTarget: unknown,
  currentInboundMessageId?: string
): Promise<ReplyTargetResult> {
  if (rawTarget === undefined || rawTarget === null) return { ok: true };
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    return { ok: false, error: 'reply_to_message_id must be a non-empty message ID' };
  }
  if (channel === 'WHATSAPP' && rawTarget === currentInboundMessageId) {
    return { ok: true, replyToMessageId: rawTarget };
  }
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { messages: true },
  });
  const target = replyMessages(session?.messages).find(
    (message, index) => replyId(message, index) === rawTarget
  );
  if (!target)
    return { ok: false, error: 'Reply target is not a known message in this conversation' };
  if (channel === 'SMS')
    return {
      ok: true,
      replyToMessageId: rawTarget,
      quotedMessage: {
        role: target.role === 'user' ? 'user' : 'assistant',
        content: String(target.content),
      },
    };
  if (target.providerMessageId !== rawTarget)
    return {
      ok: false,
      error: 'This older message has no WhatsApp provider ID for a native reply',
    };
  return { ok: true, replyToMessageId: rawTarget };
}

function replyMessages(rawMessages: unknown): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string'
  );
}

/** Positions refer to literal conversation turns after the system prompt. */
export function formatReplyTargetIndex(rawMessages: unknown, excludeInboundSeq?: number): string {
  const messages = replyMessages(rawMessages);
  const retained = messages.filter(
    (entry) => excludeInboundSeq === undefined || entry.inboundSeq !== excludeInboundSeq
  );
  const positions = new Map(retained.map((entry, index) => [entry, index + 1]));
  const entries = messages.map((entry, index) => {
    const current = excludeInboundSeq !== undefined && entry.inboundSeq === excludeInboundSeq;
    return {
      reply_to_message_id: replyId(entry, index),
      history_position: current ? retained.length + 1 : positions.get(entry),
      role: entry.role,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      ...(current ? { current_incoming_message: true } : {}),
    };
  });
  if (entries.length === 0) return '';
  return (
    '\n\n# Reply targets (internal)\n' +
    'Use reply_to_message_id only when quoting a message helps. SMS includes the selected text as a quote; WhatsApp uses a native reply. IDs stay internal. ' +
    'history_position is 1-based after the system prompt; current incoming message follows retained history.\n' +
    JSON.stringify(entries)
  );
}
