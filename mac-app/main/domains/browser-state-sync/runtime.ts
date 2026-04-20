import { sync, syncBrowser, syncBrowserPasswordsOnly } from './service';
import type { SyncBrowserOptions, UploadResult } from './types';

/**
 * BrowserStateSync — main-process façade for cross-browser state sync.
 *
 * Coordinates syncing of cookies, localStorage, IndexedDB, permissions, Cache
 * Storage, passwords, and fingerprints to the backend. Runs uploads in
 * parallel. Safe to invoke without an authenticated session (no-op).
 *
 * External callers (IPC handlers, SyncManager) use the static methods below.
 */
export class BrowserStateSync {
  static async sync(): Promise<void> {
    await sync();
  }

  static async syncBrowser(
    browserType: string,
    options?: SyncBrowserOptions
  ): Promise<UploadResult> {
    return syncBrowser(browserType, options);
  }

  static async syncBrowserPasswordsOnly(
    browserType: string,
    options?: SyncBrowserOptions
  ): Promise<UploadResult> {
    return syncBrowserPasswordsOnly(browserType, options);
  }

  /**
   * @deprecated Use SyncManager.startAll() instead.
   * SyncManager now handles periodic sync intervals centrally.
   */
  static startBackgroundSync(): void {
    console.log(
      '[BrowserStateSync] startBackgroundSync() is deprecated. Use SyncManager.startAll()'
    );
  }

  /** @deprecated Use SyncManager.stopAll() instead. */
  static stopBackgroundSync(): void {
    // SyncManager handles periodic syncs now - no-op
  }
}
