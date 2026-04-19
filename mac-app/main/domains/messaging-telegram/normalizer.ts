/**
 * messaging-telegram normalizer (pure function) — sub-module of the service layer.
 *
 * Maps a GramJS `Api.Message` onto the cross-platform `NormalizedMessage` contract.
 * Pure: no I/O, no class state, no logging. Safe for unit testing in isolation.
 */
import { Api } from 'telegram/tl';
import type { NormalizedMessage } from './types';

export function normalizeTelegramMessage(msg: Api.Message): NormalizedMessage | null {
  if (msg.id === undefined || msg.id === null || msg.text === undefined || msg.text.length === 0) {
    return null;
  }

  const peerId = msg.peerId;
  let contactId: string;
  let chatId: string;

  if (peerId instanceof Api.PeerUser) {
    contactId = String(peerId.userId);
    chatId = contactId;
  } else if (peerId instanceof Api.PeerChat) {
    chatId = String(peerId.chatId);
    const fromId = msg.fromId;
    contactId = fromId instanceof Api.PeerUser ? String(fromId.userId) : chatId;
  } else if (peerId instanceof Api.PeerChannel) {
    chatId = String(peerId.channelId);
    const fromId = msg.fromId;
    contactId = fromId instanceof Api.PeerUser ? String(fromId.userId) : chatId;
  } else {
    return null;
  }

  const timestamp =
    msg.date !== undefined && msg.date !== null ? new Date(msg.date * 1000) : new Date();

  return {
    id: String(msg.id),
    text: msg.text,
    timestamp,
    isFromMe: msg.out ?? false,
    chatId,
    contactId,
    contactName: undefined,
    channel: 'TELEGRAM',
  };
}
