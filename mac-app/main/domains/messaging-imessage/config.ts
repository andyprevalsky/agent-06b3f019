/**
 * messaging-imessage: config layer
 *
 * Constants and env reads for the iMessage platform watcher. Config may import
 * from own types only (none needed here).
 */
import { app } from 'electron';
import path from 'path';

/**
 * Full path to the macOS Messages SQLite database. The watcher is installed on
 * this single file — every new iMessage conversation write updates it, so
 * `fs.watch` is sufficient to drive near-real-time sync.
 *
 * Resolved at module-load time via Electron's `app.getPath('home')` so tests
 * can stub the home dir before the watcher is constructed.
 */
export const CHAT_DB_PATH: string = path.join(app.getPath('home'), 'Library/Messages/chat.db');

/**
 * Debounce window for `fs.watch` 'change' events. macOS issues a burst of
 * change events for a single SQLite write (journal, WAL, index); collapsing
 * them into one query run protects the downstream `queryNewMessages` provider
 * from redundant work.
 */
export const DEBOUNCE_MS = 1000;

/**
 * Integration key used by the backend + IntegrationCache for iMessage.
 */
export const INTEGRATION_KEY = 'imessage';
