/**
 * i-message-reader — config layer
 *
 * Constants, defaults, and env reads for the iMessage reader domain.
 * Layer rule: config may import from own types only.
 */

import { app } from 'electron';
import path from 'path';

/**
 * Filesystem path to the iMessage SQLite database on macOS.
 */
export const IMESSAGE_DB_PATH = path.join(app.getPath('home'), 'Library/Messages/chat.db');

/**
 * Sentinel used in place of a missing/empty handle string.
 */
export const INVALID_HANDLE_SENTINEL = 'unknown';

/**
 * Seconds between the Unix epoch (1970-01-01) and the Apple epoch (2001-01-01).
 * iMessage stores timestamps as nanoseconds since the Apple epoch.
 */
export const APPLE_EPOCH_OFFSET_SECONDS = 978307200;

/**
 * Numeric contact-id strings up to this length are treated as short codes
 * (e.g. alerts / 2FA senders) and dropped.
 */
export const SHORT_CODE_MAX_LENGTH = 8;

/**
 * Maximum recursion depth used while searching a decoded attributedBody plist
 * for a string payload.
 */
export const ATTRIBUTED_BODY_SEARCH_MAX_DEPTH = 5;
