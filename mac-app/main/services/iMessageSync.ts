import { config } from '../base/config';
import { AuthService } from './auth';
import { IMessageReader } from './iMessageReader';
import { BatchUploader } from './batchUploader';

const SYNC_INTERVAL_MS = (5 * 60 * 1000); // 5 minutes

interface Integration {
  name: string;
  config?: {
    lastFrontendAccessAt?: string;
  };
}

export class IMessageSync {
  private static intervalId: NodeJS.Timeout | null = null;

  static async sync(): Promise<void> {
    const session = AuthService.getSession();
    if (!session) {
      console.log('[IMessageSync] Skipping sync - not authenticated');
      return;
    }

    if (!IMessageReader.checkAccess()) {
      console.log('[IMessageSync] Skipping sync - no iMessage access');
      return;
    }

    try {
      // Fetch integrations to get last sync timestamp
      const response = await fetch(`${config.apiUrl}/api/integrations`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        console.error('[IMessageSync] Failed to fetch integrations:', response.statusText);
        return;
      }

      const data = await response.json() as { integrations?: Integration[] };
      const integrations = data.integrations;
      const imessageIntegration = integrations?.find(i => i.name === 'imessage');
      
      const lastAccessedAt = imessageIntegration?.config?.lastFrontendAccessAt;
      
      // Read messages (filtered by timestamp if available)
      const isIncrementalSync = !!lastAccessedAt;
      console.log(`[IMessageSync] Reading messages${lastAccessedAt ? ` since ${lastAccessedAt}` : ' (full sync)'}`);
      const messages = await IMessageReader.readMessages(lastAccessedAt, isIncrementalSync);

      if (messages.length === 0) {
        console.log('[IMessageSync] No new messages to sync');
        return;
      }

      console.log(`[IMessageSync] Found ${messages.length} new messages, uploading...`);
      const result = await BatchUploader.uploadInBatches(
        'imessage',
        messages,
        session.access_token,
        null // No window for background sync
      );

      if (result.success) {
        console.log('[IMessageSync] ✅ Sync complete');
      } else {
        console.error('[IMessageSync] ❌ Sync failed:', result.message);
      }
    } catch (error) {
      console.error('[IMessageSync] Error during sync:', error);
    }
  }

  static startBackgroundSync(): void {
    if (this.intervalId) {
      console.log('[IMessageSync] Background sync already running');
      return;
    }

    console.log(`[IMessageSync] Starting background sync (every ${SYNC_INTERVAL_MS / 1000 / 60} minutes)`);
    this.intervalId = setInterval(() => {
      this.sync().catch(err => console.error('[IMessageSync] Background sync error:', err));
    }, SYNC_INTERVAL_MS);
  }

  static stopBackgroundSync(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[IMessageSync] Background sync stopped');
    }
  }
}

