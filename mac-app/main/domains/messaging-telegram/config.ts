/**
 * messaging-telegram config layer.
 *
 * Constants, defaults, and env reads for the Telegram platform.
 * Imports only from own types.
 */
import { app } from 'electron';
import path from 'path';

/**
 * Directory where the GramJS StringSession is persisted to disk.
 */
export const TELEGRAM_AUTH_DIR: string = path.join(app.getPath('userData'), 'telegram-auth');

/**
 * Filename of the persisted StringSession blob inside TELEGRAM_AUTH_DIR.
 */
export const SESSION_FILE = 'session.txt';

/**
 * Telegram API credentials read at module-load time.
 * Obtained from https://my.telegram.org — absent in tests by default.
 */
export const API_ID: number = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10);
export const API_HASH: string = process.env.TELEGRAM_API_HASH ?? '';

/**
 * Batch-flush cadence for the real-time message buffer.
 */
export const FLUSH_INTERVAL_MS = 5000;

/**
 * Max size of the real-time message buffer before a forced flush.
 */
export const MAX_BUFFER_SIZE = 100;

/**
 * Default historical-sync page size per dialog.
 */
export const DEFAULT_MESSAGES_PER_DIALOG = 100;

/**
 * Default dialog-list page size.
 */
export const DEFAULT_DIALOG_LIMIT = 100;

/**
 * GramJS connection retry count on transient network failures.
 */
export const CONNECTION_RETRIES = 5;

/**
 * Integration key used by the backend and IntegrationCache for Telegram.
 */
export const INTEGRATION_KEY = 'telegram';

/** Per-account sessions live in TELEGRAM_AUTH_DIR/accounts/<telegram user id>/. */
export const ACCOUNTS_DIR: string = path.join(TELEGRAM_AUTH_DIR, 'accounts');

/** Per-account profile (label, legacy-claim flag) beside the session file. */
export const PROFILE_FILE = 'account.json';

/** A Telegram account id is the numeric Telegram user id (also guards path joins). */
export const ACCOUNT_ID_PATTERN = /^\d{1,20}$/;

/** Chats whose history is uploaded together; one progress write follows each batch. */
export const DIALOGS_PER_BATCH = 10;

/** Progress unit reported for Telegram history sync. */
export const PROGRESS_UNIT = 'chats';
