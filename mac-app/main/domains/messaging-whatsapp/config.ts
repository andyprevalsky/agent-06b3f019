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

/** Integration name used in Uploader + IntegrationCache lookups. */
export const WHATSAPP_INTEGRATION_NAME = 'whatsapp';

/** Baileys DisconnectReason.loggedOut status code. */
export const WHATSAPP_STATUS_LOGGED_OUT = 401;

/** Baileys DisconnectReason.restartRequired status code. */
export const WHATSAPP_STATUS_RESTART_REQUIRED = 515;
