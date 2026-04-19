/**
 * messaging-core: runtime layer
 *
 * Public barrel for the messaging-core domain. Re-exports the service class
 * and every type consumers need, plus the platform sub-domains. External
 * callers (iMessageSync, sync/SyncManager, handlers/registry, and the
 * messaging-core blackbox) should depend on this entry, not on individual
 * layer files.
 *
 * Platform classes (IMessageWatcher, WhatsApp*, Telegram*) live in sibling
 * domains (messaging-imessage, messaging-whatsapp, messaging-telegram). We
 * re-export them here so the public barrel at main/services/messaging
 * continues to surface the same names it always has — keeping the public
 * contract stable while the internals move.
 */

// Types
export * from './types';

// Service
export { MessageTransformer } from './service';

// Platform sub-domains (still owned by their own workers / folders)
export * from '../../services/messaging/platforms/imessage';
export * from '../../services/messaging/platforms/whatsapp';
export * from '../../services/messaging/platforms/telegram';
