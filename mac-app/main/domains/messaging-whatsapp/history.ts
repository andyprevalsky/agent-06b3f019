/**
 * messaging-whatsapp: historical-fetch helpers
 *
 * Best-effort adapters over Baileys' undocumented history APIs. Kept in their
 * own file so the WhatsAppClient class in `service.ts` stays focused on
 * connection lifecycle.
 *
 * Note: Baileys v7.0+ broke `fetchMessageHistory` — these helpers return empty
 * arrays on failure rather than throwing so callers can keep operating.
 */
import { normalizeMessage, type WABaileysMessage } from './normalize';
import type { NormalizedMessage } from './types';

/** Typed shape of the subset of WASocket methods this file reaches into. */
interface HistoryCapableSocket {
  fetchMessageHistory?: (chatId: string, limit: number) => Promise<unknown>;
}

/**
 * Attempt to fetch + normalize historical messages for a chat. Returns an
 * empty array when the socket is null, the method is unavailable, or Baileys
 * throws.
 */
export async function fetchHistoricalMessages(
  sock: HistoryCapableSocket | null,
  isConnected: boolean,
  chatId: string,
  limit: number
): Promise<NormalizedMessage[]> {
  if (sock === null || !isConnected) {
    console.warn('[WhatsAppClient] Cannot fetch history - not connected');
    return [];
  }

  try {
    console.log(`[WhatsAppClient] Attempting to fetch ${limit} historical messages for ${chatId}`);
    const messages: NormalizedMessage[] = [];
    try {
      if (typeof sock.fetchMessageHistory === 'function') {
        const history = await sock.fetchMessageHistory(chatId, limit);
        if (Array.isArray(history)) {
          for (const msg of history) {
            const normalized = normalizeMessage(msg as WABaileysMessage);
            if (normalized !== null) messages.push(normalized);
          }
        }
      }
    } catch (histErr) {
      console.log('[WhatsAppClient] fetchMessageHistory not available or failed:', histErr);
    }
    console.log(`[WhatsAppClient] Historical fetch returned ${messages.length} messages`);
    return messages;
  } catch (error) {
    console.error('[WhatsAppClient] Error fetching historical messages:', error);
    return [];
  }
}

/**
 * Placeholder for chat enumeration. Baileys has no direct API — chats are
 * discovered through `messages.upsert` events. Returns empty until a store-
 * backed implementation lands.
 */
export function listChats(
  sock: unknown,
  isConnected: boolean
): { id: string; name?: string; isGroup: boolean }[] {
  if (sock === null || !isConnected) return [];
  return [];
}
