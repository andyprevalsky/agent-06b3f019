/**
 * messaging-imessage: types layer
 *
 * Re-exports the cross-platform messaging types this domain consumes. The
 * canonical messaging contract lives in `main/services/messaging/types.ts`
 * (shared across all platform domains).
 *
 * Import rule: types-only. No project imports besides cross-domain messaging
 * types (treated as the shared contract / provider types for the messaging
 * layer).
 */
import type {
  ConnectionState,
  MessageChannel,
  NormalizedMessage,
  SyncEvent,
  SyncEventType,
} from '../../services/messaging/types';

export type { ConnectionState, MessageChannel, NormalizedMessage, SyncEvent, SyncEventType };

/**
 * Signature for the function the watcher invokes after a debounced chat.db
 * change to pull any new rows. Kept as a stand-alone alias so the service
 * layer's constructor contract is self-documenting.
 */
export type QueryNewMessages = () => Promise<NormalizedMessage[]>;
