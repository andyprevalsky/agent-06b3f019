/**
 * messaging-imessage: runtime layer
 *
 * Public barrel for the messaging-imessage domain. External callers
 * (i-message-sync runtime, messaging-core runtime, and the messaging-imessage
 * blackbox via its legacy shim path) should depend on this entry or the
 * legacy `main/services/messaging/platforms/imessage` shim — not on the
 * individual layer files.
 *
 * This domain is unusual in that it has no long-lived coordinator of its own
 * (no static `Sync` class). The platform-level sync cadence is driven by
 * `i-message-sync` which composes the watcher with chat.db reads. So the
 * runtime layer is a pure re-export surface.
 */
export { IMessageWatcher } from './service';
export type {
  ConnectionState,
  MessageChannel,
  NormalizedMessage,
  QueryNewMessages,
  SyncEvent,
  SyncEventType,
} from './types';
