/**
 * Minimum age (ms) before a SYNCING integration is treated as stale and re-synced.
 */
export const STALE_SYNC_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Integration (provider) slug on the backend. */
export const INTEGRATION_NAME = 'imessage';

/** chat.db message rows scanned per uploaded batch (one upload + one progress write). */
export const SYNC_BATCH_ROWS = 500;

/**
 * Consecutive failed attempts at the same batch before the run is reported
 * `failed`. Rows already uploaded stay uploaded; the next run resumes after them.
 */
export const MAX_BATCH_FAILURES = 3;

/** File under Electron userData holding each user's cursor and in-flight run. */
export const SYNC_STATE_FILE = 'imessage-sync-state.json';

/** Progress unit and phase reported for this provider. */
export const PROGRESS_UNIT = 'messages';
export const PROGRESS_PHASE = 'uploading';

/** Per-account progress endpoint (I0 contract). */
export function progressPath(accountId: string): string {
  return `/api/integrations/${INTEGRATION_NAME}/accounts/${encodeURIComponent(accountId)}/progress`;
}
