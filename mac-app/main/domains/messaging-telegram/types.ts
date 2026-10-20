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
