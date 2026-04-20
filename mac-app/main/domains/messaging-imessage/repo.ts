/**
 * messaging-imessage: repo layer
 *
 * Sole consumer of `fs.watch` on the macOS Messages database file. This layer
 * owns the raw filesystem watcher lifecycle; the service layer composes it
 * with debouncing + the application-supplied `queryNewMessages` callback.
 *
 * The actual row-level reads of chat.db live in the sibling `i-message-reader`
 * domain — this file only exposes a change-event stream.
 *
 * Import rule: own config, own types, `fs` — nothing else.
 */
import { watch, type FSWatcher } from 'fs';
import { CHAT_DB_PATH } from './config';

/**
 * Minimal change-listener signature matching Node's `fs.watch` callback.
 * Kept local so the service layer never imports `fs` types directly.
 */
export type ChatDbChangeListener = (eventType: string, filename: string | null) => void;

/**
 * Open a filesystem watcher on the Messages chat.db file. Throws the native
 * fs error synchronously if the underlying file cannot be watched — callers
 * are expected to translate that into a domain-level error event.
 */
export function watchChatDb(listener: ChatDbChangeListener): FSWatcher {
  return watch(CHAT_DB_PATH, listener);
}

export type { FSWatcher };
