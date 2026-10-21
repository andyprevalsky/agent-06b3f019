/**
 * messaging-core: type layer
 *
 * Shapes shared across every messaging platform (iMessage / WhatsApp / Telegram).
 * A platform-specific watcher normalises its feed to NormalizedMessage, the service
 * layer groups + transforms, and the Uploader posts ContactWithMessages to the backend.
 *
 * Import rule: types-only. No project imports besides external/provider types.
 */

/**
 * Unified message format that all messaging platforms (iMessage, WhatsApp, Telegram)
 * normalize to before transformation to backend format.
 */
export interface NormalizedMessage {
  /** Unique message ID (platform-specific format converted to string) */
  id: string;
  /** Message text content */
  text: string;
  /** Message timestamp */
  timestamp: Date;
  /** True if message was sent by the user */
  isFromMe: boolean;
  /** Chat/conversation identifier (iMessage chat_identifier, WhatsApp jid, Telegram peerId) */
  chatId: string;
  /** Contact identifier (phone number, email, or handle) */
  contactId: string;
  /** Contact display name if available */
  contactName?: string;
  /** Source platform */
  channel: MessageChannel;
  /** Contact enrichment data */
  contact?: {
    firstName?: string;
    lastName?: string;
    company?: string;
    title?: string;
    email?: string;
    emailAddresses?: string[];
  };
}

export type MessageChannel = 'IMESSAGE' | 'WHATSAPP' | 'TELEGRAM';

/**
 * Contact with messages in backend-expected format.
 * This is what MessageTransformer outputs and what gets sent to the backend API.
 */
export interface ContactWithMessages {
  contact_id: string;
  contact_name: string | null;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  emailAddresses?: string[];
  messages: {
    id: string;
    text: string;
    /** Apple-epoch timestamp in nanoseconds (for iMessage) or Unix timestamp in ms */
    date: number;
    is_from_me: boolean;
    contactHandle?: string;
  }[];
}

/**
 * Sync event types emitted by platform watchers
 */
export type SyncEventType = 'new_messages' | 'connection_change' | 'error';

export interface SyncEvent {
  type: SyncEventType;
  channel: MessageChannel;
  messages?: NormalizedMessage[];
  connected?: boolean;
  error?: Error;
  /** History-sync batches only: the platform's progress (0-100) and whether this is the last batch. */
  history?: { progress: number | null; isLatest: boolean };
}

/**
 * Platform connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PlatformStatus {
  channel: MessageChannel;
  state: ConnectionState;
  lastSyncAt?: Date;
  error?: string;
}

/**
 * Auth callbacks for platforms requiring interactive authentication
 */
export interface TelegramAuthCallbacks {
  onPhoneRequest: () => Promise<string>;
  onCodeRequest: () => Promise<string>;
  onPasswordRequest: () => Promise<string>;
}

export interface WhatsAppAuthCallbacks {
  onQRCode: (qr: string) => void;
  /**
   * Fired when the socket actually reaches `connection === 'open'`. Backend
   * registration hangs off this rather than off `connect()` resolving, because
   * `connect()` also resolves on the QR-scan timeout without a pairing.
   */
  onConnected?: () => void | Promise<void>;
}

/**
 * Per-contact accumulator used internally by the service layer while it groups
 * NormalizedMessage batches into ContactWithMessages.
 */
export interface ContactAccumulator {
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

/**
 * Stats summary returned by MessageTransformer.getStats.
 */
export interface MessageBatchStats {
  total: number;
  fromUser: number;
  fromOthers: number;
  uniqueContacts: number;
  byChannel: Record<MessageChannel, number>;
}
