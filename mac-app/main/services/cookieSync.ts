import { config } from '../base/config';
import { AuthService } from './auth';
import { CookieReader } from './cookieReader';
import { BatchUploader } from './batchUploader';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface Integration {
  name: string;
  status: string;
}

export class CookieSync {
  private static intervalId: NodeJS.Timeout | null = null;

  static async sync(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[CookieSync] Skipping sync - not authenticated');
      return;
    }

    try {
      // Check if chrome integration is already connected
      const response = await fetch(`${config.apiUrl}/api/integrations`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        console.error('[CookieSync] Failed to fetch integrations:', response.statusText);
        return;
      }

      const data = await response.json() as { integrations?: Integration[] };
      const integrations = data.integrations;
      const cookieIntegration = integrations?.find(i => i.name === 'chrome');

      // Only sync if already connected (user has previously synced)
      if (!cookieIntegration || cookieIntegration.status !== 'CONNECTED') {
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
        console.log('[CookieSync] ✅ Sync complete');
      } else {
        console.error('[CookieSync] ❌ Sync failed:', result.message);
      }
    } catch (error) {
      console.error('[CookieSync] Error during sync:', error);
    }
  }

  static startBackgroundSync(): void {
    if (this.intervalId) {
      console.log('[CookieSync] Background sync already running');
      return;
    }

    console.log(`[CookieSync] Starting background sync (every ${SYNC_INTERVAL_MS / 1000 / 60} minutes)`);
    this.intervalId = setInterval(() => {
      this.sync().catch(err => console.error('[CookieSync] Background sync error:', err));
    }, SYNC_INTERVAL_MS);
  }

  static stopBackgroundSync(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[CookieSync] Background sync stopped');
    }
  }
}

