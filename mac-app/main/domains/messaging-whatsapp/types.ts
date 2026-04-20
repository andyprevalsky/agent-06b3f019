/**
 * messaging-whatsapp: types layer
 *
 * Re-exports the cross-platform messaging types this domain consumes plus any
 * whatsapp-specific aliases. The canonical messaging contract lives in
 * `main/services/messaging/types.ts` (shared across all platform domains).
 */
export type {
  NormalizedMessage,
  MessageChannel,
  ContactWithMessages,
  SyncEventType,
  SyncEvent,
  ConnectionState,
  PlatformStatus,
  WhatsAppAuthCallbacks,
} from '../../services/messaging/types';

/**
 * Raw Baileys credential file shape — only the fields this domain reads.
 * Baileys writes many more but we never parse them here.
 */
export interface WhatsAppCredsFile {
  me?: { id?: string };
}

/**
 * Partial of Baileys' connection update event payload we rely on.
 */
export interface WhatsAppConnectionCloseError {
  output?: { statusCode?: number };
}
