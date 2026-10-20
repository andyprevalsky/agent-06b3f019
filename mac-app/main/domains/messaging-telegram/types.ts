/**
 * messaging-telegram types layer.
 *
 * Types-only module. Imports:
 *   - External packages (for SDK type references only)
 *   - Cross-domain messaging types (platform-neutral contracts)
 */
import type { ConnectionState, NormalizedMessage, SyncEvent } from '../../services/messaging/types';

export type { ConnectionState, NormalizedMessage, SyncEvent };

/**
 * Auth flow state for the MTProto authentication state machine.
 */
export type AuthState = 'idle' | 'awaiting_code' | 'awaiting_password' | 'authenticated';

/**
 * Lightweight dialog descriptor returned by TelegramClient.getDialogs.
 */
export interface DialogSummary {
  id: string;
  name: string;
  isGroup: boolean;
  isChannel: boolean;
}

/**
 * Result returned by startAuth — {success, error?} contract exposed to runtime.
 */
export interface StartAuthResult {
  success: boolean;
  error?: string;
}

/** Who a Telegram session belongs to: accountId is the numeric Telegram user id. */
export interface TelegramIdentity {
  accountId: string;
  /** @username, else display name, else +phone; null when Telegram reports none. */
  label: string | null;
}

/** Per-account profile persisted beside the session (`account.json`). */
export interface TelegramAccountProfile {
  label: string | null;
  /** Set when this account came from the legacy single-session login; cleared once registered. */
  claimLegacy?: boolean;
}

/** One entry of TelegramSync.listAccounts(). */
export interface TelegramAccountSummary {
  accountId: string;
  label: string | null;
  connected: boolean;
}

/** Sync states accepted by POST /api/integrations/:provider/accounts/:accountId/progress. */
export type ProgressState = 'idle' | 'syncing' | 'synced' | 'failed' | 'needs_reconnect';

/** One progress observation (the reporter adds runId and seq). */
export interface ProgressUpdate {
  state: ProgressState;
  done?: number | null;
  total?: number | null;
  unit?: string | null;
  /** Estimated seconds left from the measured rate; null when unknown. */
  eta_sec?: number | null;
  error?: string | null;
}

/** Wire body of one progress write. */
export interface ProgressBody extends ProgressUpdate {
  runId: string;
  seq: number;
}

/** How the backend judged one progress write. */
export type ProgressSendResult =
  | { kind: 'applied' }
  | { kind: 'coalesced'; retryAfterMs: number }
  | { kind: 'rejected'; status: number };

export type ProgressSend = (body: ProgressBody) => Promise<ProgressSendResult>;

/** Outcome of one account's historical sync run. */
export interface HistorySyncResult {
  messages: number;
  chatsTotal: number;
  chatsSaved: number;
  unreadableChats: number;
  uploadFailed: boolean;
}
