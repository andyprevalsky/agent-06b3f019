import { COOKIE_SYNC_LOG_PREFIX } from './config';
import { runCookieSync } from './service';

/**
 * Public entry point for cookie-sync. External callers (SyncManager,
 * handlers/registry, tests) invoke `CookieSync.sync()` — the class shape is
 * preserved for backward compatibility with blackbox test mocks and existing
 * import sites.
 *
 * The runtime layer is intentionally thin: validate nothing (no inputs),
 * delegate to the service, and swallow the result. Errors are already caught
 * inside the service so the contract remains `Promise<void>` that never throws.
 */
export class CookieSync {
  static async sync(): Promise<void> {
    await runCookieSync();
  }

  /**
   * @deprecated Use SyncManager.startAll() instead.
   * SyncManager now handles periodic sync intervals centrally.
   */
  static startBackgroundSync(): void {
    console.log(
      `${COOKIE_SYNC_LOG_PREFIX} startBackgroundSync() is deprecated. Use SyncManager.startAll()`
    );
  }

  /**
   * @deprecated Use SyncManager.stopAll() instead.
   */
  static stopBackgroundSync(): void {
    // SyncManager handles periodic syncs now - no-op
  }
}
