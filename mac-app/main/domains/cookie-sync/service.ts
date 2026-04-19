import { COOKIE_SYNC_LOG_PREFIX } from './config';
import { fetchCurrentSession, isIntegrationConnected, readCookies, uploadCookies } from './repo';
import type { CookieSyncOutcome } from './types';

/**
 * Orchestrates the cookie-sync workflow:
 *   1. Abort if unauthenticated.
 *   2. Abort if the chrome integration is not connected in the cache.
 *   3. Read cookies; abort if empty.
 *   4. Upload the encrypted batch via BatchUploader.
 *
 * All failures are reported via the typed outcome — callers never see a throw.
 * This matches the legacy `CookieSync.sync()` contract (returns `void` even on
 * error) while giving the runtime a typed value to log.
 */
export async function runCookieSync(): Promise<CookieSyncOutcome> {
  const session = await fetchCurrentSession();
  if (session === null) {
    console.log(`${COOKIE_SYNC_LOG_PREFIX} Skipping sync - not authenticated`);
    return { status: 'skipped', reason: 'unauthenticated' };
  }

  try {
    const connected = await isIntegrationConnected();
    if (!connected) {
      console.log(`${COOKIE_SYNC_LOG_PREFIX} Skipping sync - integration not connected`);
      return { status: 'skipped', reason: 'disconnected' };
    }

    console.log(`${COOKIE_SYNC_LOG_PREFIX} Reading cookies...`);
    const cookies = await readCookies();
    if (cookies.length === 0) {
      console.log(`${COOKIE_SYNC_LOG_PREFIX} No cookies to sync`);
      return { status: 'skipped', reason: 'empty' };
    }

    console.log(`${COOKIE_SYNC_LOG_PREFIX} Found ${cookies.length} cookies, uploading...`);
    const result = await uploadCookies(cookies, session.access_token);

    if (result.success) {
      console.log(`${COOKIE_SYNC_LOG_PREFIX} Sync complete`);
    } else {
      console.error(`${COOKIE_SYNC_LOG_PREFIX} Sync failed:`, result.message);
    }

    return {
      status: 'uploaded',
      count: cookies.length,
      success: result.success,
      message: result.message,
    };
  } catch (error) {
    console.error(`${COOKIE_SYNC_LOG_PREFIX} Error during sync:`, error);
    return { status: 'errored', error };
  }
}
