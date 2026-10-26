/**
 * Minimum age (ms) before a SYNCING integration is treated as stale and re-synced.
 */
export const STALE_SYNC_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Messages per upload request. A heavy user's full history (hundreds of
 * thousands of messages) must never be one request: it exceeds the backend
 * body limit and pins a huge buffer in the web process. ~5k messages keeps
 * each request at a few MB and matches the backend's stored part size.
 */
export const UPLOAD_CHUNK_MESSAGES = 5_000;
