import { AuthService } from './auth';
import { IMessageReader } from './iMessageReader';
import { BatchUploader } from './batchUploader';
import { IMessageWatcher } from './messaging/platforms/imessage/IMessageWatcher';
import { MessageTransformer } from './messaging/MessageTransformer';
import { IntegrationCache } from './sync/IntegrationCache';
import type { SyncEvent, NormalizedMessage } from './messaging/types';

export class IMessageSync {
  private static watcher: IMessageWatcher | null = null;
  private static lastSyncRowId: number = 0;

  /**
   * Check if iMessage integration is connected for the current user.
   */
  private static async isIntegrationConnected(): Promise<boolean> {
    return IntegrationCache.isConnected('imessage');
  }

  /**
   * Upload normalized messages to the backend.
   */
  private static async uploadMessages(messages: NormalizedMessage[]): Promise<boolean> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[IMessageSync] Skipping upload - not authenticated');
      return false;
    }

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const stats = MessageTransformer.getStats(messages);

    console.log(
      `[IMessageSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`
    );

    const result = await BatchUploader.uploadInBatches(
      'imessage',
      contacts,
      session.access_token,
      null
    );

    return result.success;
  }

  /**
   * Handle sync events from the real-time watcher.
   */
  private static async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type === 'error') {
      console.error('[IMessageSync] Real-time watcher error:', event.error);
      return;
    }

    if (
      event.type === 'new_messages' &&
      event.messages !== undefined &&
      event.messages.length > 0
    ) {
      // Check if integration is still connected
      const isConnected = await this.isIntegrationConnected();
      if (!isConnected) {
        console.log('[IMessageSync] Real-time: skipping upload - integration not connected');
        return;
      }

      console.log(`[IMessageSync] Real-time: ${event.messages.length} new message(s) detected`);
      const success = await this.uploadMessages(event.messages);

      if (success) {
        console.log('[IMessageSync] Real-time: upload complete');
      } else {
        console.error('[IMessageSync] Real-time: upload failed');
      }
    }
  }

  /**
   * Query new messages since the last known ROWID for real-time watcher.
   */
  private static async queryNewMessagesForWatcher(): Promise<NormalizedMessage[]> {
    const rawMessages = await IMessageReader.readMessagesSinceRowId(this.lastSyncRowId);

    if (rawMessages.length > 0) {
      // Update lastSyncRowId
      const maxId = Math.max(...rawMessages.map((m) => m.id));
      if (maxId > this.lastSyncRowId) {
        this.lastSyncRowId = maxId;
      }
    }

    return IMessageReader.toNormalizedMessages(rawMessages);
  }

  /**
   * Start real-time file watching for iMessage database changes.
   */
  static startRealTimeSync(): void {
    if (this.watcher?.isActive() === true) {
      console.log('[IMessageSync] Real-time sync already running');
      return;
    }

    if (!IMessageReader.checkAccess()) {
      console.log('[IMessageSync] Cannot start real-time sync - no iMessage access');
      return;
    }

    // Initialize the last ROWID to current max to avoid re-syncing existing messages
    this.lastSyncRowId = IMessageReader.getMaxRowId();
    console.log(`[IMessageSync] Initializing real-time sync from ROWID ${this.lastSyncRowId}`);

    this.watcher = new IMessageWatcher(() => this.queryNewMessagesForWatcher());
    this.watcher.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch((err) => {
        console.error('[IMessageSync] Error handling sync event:', err);
      });
    });

    this.watcher.start();
    console.log('[IMessageSync] Real-time sync started');
  }

  /**
   * Stop real-time file watching.
   */
  static stopRealTimeSync(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher.removeAllListeners();
      this.watcher = null;
      console.log('[IMessageSync] Real-time sync stopped');
    }
  }

  /**
   * Full sync (used for periodic background sync and initial sync).
   */
  static async sync(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[IMessageSync] Skipping sync - not authenticated');
      return;
    }

    if (!IMessageReader.checkAccess()) {
      console.log('[IMessageSync] Skipping sync - no iMessage access');
      return;
    }

    try {
      // Check integration status via cache
      const integration = await IntegrationCache.getIntegration('imessage');

      // Only sync if integration exists (user has previously synced)
      if (!integration || integration.status === 'NOT_CONNECTED') {
        console.log('[IMessageSync] Skipping sync - integration not found');
        return;
      }

      // If SYNCING and last sync was < 1 hour ago, skip (sync is likely still in progress)
      if (
        integration.status === 'SYNCING' &&
        integration.lastSyncAt !== null &&
        integration.lastSyncAt !== undefined
      ) {
        const lastSyncAge = Date.now() - new Date(integration.lastSyncAt).getTime();
        const ONE_HOUR = 60 * 60 * 1000;
        if (lastSyncAge < ONE_HOUR) {
          console.log(
            `[IMessageSync] Skipping sync - already syncing (last sync ${Math.round(lastSyncAge / 60000)}m ago)`
          );
          return;
        }
        console.log(
          `[IMessageSync] Re-syncing - SYNCING status stale (last sync ${Math.round(lastSyncAge / 60000)}m ago)`
        );
      }

      const integrationConfig = integration.config as { lastFrontendAccessAt?: string } | undefined;
      const lastAccessedAt = integrationConfig?.lastFrontendAccessAt;

      // Read messages (filtered by timestamp if available)
      const isIncrementalSync = lastAccessedAt !== undefined && lastAccessedAt !== '';
      console.log(
        `[IMessageSync] Reading messages${isIncrementalSync ? ` since ${lastAccessedAt}` : ' (full sync)'}`
      );
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
        console.log('[IMessageSync] Sync complete');
        // Update lastSyncRowId for real-time watcher
        if (messages.length > 0) {
          const maxId = Math.max(...messages.map((m) => m.id));
          if (maxId > this.lastSyncRowId) {
            this.lastSyncRowId = maxId;
          }
        }
      } else {
        console.error('[IMessageSync] Sync failed:', result.message);
      }
    } catch (error) {
      console.error('[IMessageSync] Error during sync:', error);
    }
  }

  /**
   * @deprecated Use SyncManager.startAll() instead. This is kept for backward compatibility.
   * SyncManager now handles periodic sync intervals centrally.
   */
  static startBackgroundSync(): void {
    // SyncManager handles periodic syncs now - just start real-time
    this.startRealTimeSync();
  }

  /**
   * @deprecated Use SyncManager.stopAll() instead.
   */
  static stopBackgroundSync(): void {
    this.stopRealTimeSync();
  }

  /**
   * Check if real-time sync is active.
   */
  static isRealTimeSyncActive(): boolean {
    return this.watcher?.isActive() ?? false;
  }
}
