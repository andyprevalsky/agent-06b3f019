import { AuthService } from './auth';
import { CookieReader } from './cookieReader';
import { BatchUploader } from './batchUploader';
import { IntegrationCache } from './sync/IntegrationCache';

export class CookieSync {
  static async sync(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[CookieSync] Skipping sync - not authenticated');
      return;
    }

    try {
      // Check if chrome integration is already connected via cache
      const isConnected = await IntegrationCache.isConnected('chrome');

      // Only sync if already connected (user has previously synced)
      if (!isConnected) {
        console.log('[CookieSync] Skipping sync - integration not connected');
        return;
      }

      // Read all cookies
      console.log('[CookieSync] Reading cookies...');
      const cookies = await CookieReader.readCookies();

      if (cookies.length === 0) {
        console.log('[CookieSync] No cookies to sync');
        return;
      }

      console.log(`[CookieSync] Found ${cookies.length} cookies, uploading...`);
      const result = await BatchUploader.uploadInBatches(
        'chrome',
        cookies,
        session.access_token,
        null // No window for background sync
      );

      if (result.success) {
        console.log('[CookieSync] Sync complete');
      } else {
        console.error('[CookieSync] Sync failed:', result.message);
      }
    } catch (error) {
      console.error('[CookieSync] Error during sync:', error);
    }
  }

  /**
   * @deprecated Use SyncManager.startAll() instead.
   * SyncManager now handles periodic sync intervals centrally.
   */
  static startBackgroundSync(): void {
    // SyncManager handles periodic syncs now - no-op
    console.log('[CookieSync] startBackgroundSync() is deprecated. Use SyncManager.startAll()');
  }

  /**
   * @deprecated Use SyncManager.stopAll() instead.
   */
  static stopBackgroundSync(): void {
    // SyncManager handles periodic syncs now - no-op
  }
}
