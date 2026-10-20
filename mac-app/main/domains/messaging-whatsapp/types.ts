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

/** Sync states the backend progress contract accepts (syncAccountsContract.SYNC_STATES). */
export type WhatsAppSyncState = 'syncing' | 'synced' | 'failed' | 'needs_reconnect';

/**
 * Body of POST /api/integrations/whatsapp/accounts/:accountId/progress.
 * `total` is always null: WhatsApp never says how many messages a history sync
 * holds, so `done` (messages saved) is a count, not a fraction. `pct` is
 * Baileys' own history-sync percent, or null when it reported none.
 */
export interface WhatsAppProgressWrite {
  runId: string;
  seq: number;
  state: WhatsAppSyncState;
  phase: string | null;
  done: number;
  total: null;
  pct: number | null;
  unit: string;
  error?: string;
}

/** How the backend judged one progress write (HTTP 200 / 202 / 409 / anything else). */
export type WhatsAppProgressPostResult =
  | { kind: 'applied' }
  | { kind: 'coalesced'; retryAfterMs: number }
  | { kind: 'stale' }
  | { kind: 'failed' };

export type WhatsAppProgressPoster = (
  accountId: string,
  body: WhatsAppProgressWrite
) => Promise<WhatsAppProgressPostResult>;

/** One `messaging-history.set` batch, reduced to what progress needs. */
export interface WhatsAppHistoryBatch {
  syncType: number | null;
  /** Baileys' history-sync percent (0-100), null when absent. */
  progress: number | null;
  chats: number;
  messages: number;
}

/** A linked account as listed to the UI. `accountId` = the account's E.164 phone. */
export interface WhatsAppAccountInfo {
  accountId: string;
  connected: boolean;
}
