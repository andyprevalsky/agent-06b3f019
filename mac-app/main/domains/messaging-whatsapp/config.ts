/**
 * messaging-whatsapp: config layer
 *
 * Constants, defaults, and env reads for the WhatsApp domain. Config may import
 * from own types only (none needed here).
 */
import { app } from 'electron';
import path from 'path';

/**
 * Resolve the on-disk directory where Baileys multi-file auth state lives.
 *
 * Computed lazily via a getter so tests can stub `app.getPath('userData')`
 * AFTER this module is imported (the legacy implementation captured the path
 * at module-load time, which forced tests to use `vi.resetModules()`).
 *
 * The getter caches the first resolved value to match the legacy single-shot
 * behavior — once WhatsAppAuth has read the path it is stable for the process.
 */
let cachedAuthDir: string | null = null;
export function getWhatsAppAuthDir(): string {
  if (cachedAuthDir !== null) return cachedAuthDir;
  cachedAuthDir = path.join(app.getPath('userData'), 'whatsapp-auth');
  return cachedAuthDir;
}

/** Reset the cached auth dir. Exported for tests and for post-logout clean slate. */
export function resetWhatsAppAuthDirCache(): void {
  cachedAuthDir = null;
}

/**
 * Root holding one Baileys auth dir per WhatsApp account paired since
 * multi-account (`<root>/<slot>/creds.json`). The legacy single-account dir
 * above stays where it is and is listed as one more account.
 */
export function getWhatsAppAccountsRoot(): string {
  return path.join(app.getPath('userData'), 'whatsapp-accounts');
}

/** Prefix of a newly created account slot dir (`acct-<epoch ms>-<random>`). */
export const WHATSAPP_ACCOUNT_SLOT_PREFIX = 'acct-';

/** Filename of the primary Baileys credentials file. */
export const WHATSAPP_CREDS_FILE = 'creds.json';

/** Filename of the backup copy WhatsAppAuth maintains. */
export const WHATSAPP_CREDS_BACKUP_FILE = 'creds.json.bak';

/** Period (ms) between background flushes of the sync buffer to the backend. */
export const WHATSAPP_FLUSH_INTERVAL_MS = 5_000;

/** Size at which the sync buffer force-flushes mid-interval. */
export const WHATSAPP_MAX_BUFFER_SIZE = 100;

/** Maximum automatic reconnect attempts after a 515 (restart-required) from the server. */
export const WHATSAPP_MAX_RECONNECT_ATTEMPTS = 3;

/** Delay (ms) before attempting to reconnect after clearing auth on status 515. */
export const WHATSAPP_RECONNECT_DELAY_MS = 2_000;

/** Initial connection wait timeout (ms). After this the QR flow may still continue. */
export const WHATSAPP_CONNECTION_TIMEOUT_MS = 60_000;

/** Browser identifier tuple sent to WhatsApp to blend in with a real Chrome client. */
export const WHATSAPP_BROWSER: readonly [string, string, string] = [
  'Chrome (macOS)',
  'Chrome',
  '126.0.6478.183',
];

/** A history sync with no batch for this long has delivered everything it will. */
export const WHATSAPP_HISTORY_IDLE_MS = 60_000;

/** Baileys `HistorySyncType` → the progress `phase` reported for it. */
export const WHATSAPP_HISTORY_PHASES: Readonly<Record<number, string>> = {
  0: 'initial_bootstrap',
  1: 'initial_status',
  2: 'full',
  3: 'recent',
  4: 'push_name',
  5: 'non_blocking_data',
  6: 'on_demand',
};

/** Baileys `HistorySyncType.FULL`: the last stage of a full-history sync. */
export const WHATSAPP_HISTORY_FULL = 2;

/** Progress unit: `done` counts messages saved to the backend in this run. */
export const WHATSAPP_PROGRESS_UNIT = 'messages';

/** Mirror of the server's coalescing window: one syncing write per second. */
export const WHATSAPP_PROGRESS_MIN_INTERVAL_MS = 1_000;

/** Backoff after a failed progress write (doubles per failure, capped). */
export const WHATSAPP_PROGRESS_RETRY_MS = 5_000;
export const WHATSAPP_PROGRESS_MAX_RETRY_MS = 60_000;

/** Integration name used in Uploader + IntegrationCache lookups. */
export const WHATSAPP_INTEGRATION_NAME = 'whatsapp';

/** Baileys DisconnectReason.loggedOut status code. */
export const WHATSAPP_STATUS_LOGGED_OUT = 401;

/** Baileys DisconnectReason.restartRequired status code. */
export const WHATSAPP_STATUS_RESTART_REQUIRED = 515;
