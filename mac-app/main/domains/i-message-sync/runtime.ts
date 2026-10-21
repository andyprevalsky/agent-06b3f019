import { IMessageWatcher } from '../../services/messaging/platforms/imessage/IMessageWatcher';
import {
  canStartRealTimeSync,
  fetchNewMessagesSinceRowId,
  handleSyncEvent,
  initialRealTimeRowId,
  runFullSync,
} from './service';
import type { NormalizedMessage, SyncEvent } from './types';

/**
 * Entry-point controller for the iMessage sync domain. Owns the long-lived
 * IMessageWatcher instance and the last-seen ROWID cursor. All business logic
 * lives in ./service; this class is a thin wrapper so existing call sites
 * (SyncManager, IPC registry, blackbox tests) keep their public contract.
 */
export class IMessageSync {
  private static watcher: IMessageWatcher | null = null;
  private static lastSyncRowId: number = 0;

  private static async queryNewMessagesForWatcher(): Promise<NormalizedMessage[]> {
    const { messages, newMaxRowId } = await fetchNewMessagesSinceRowId(this.lastSyncRowId);
    this.lastSyncRowId = newMaxRowId;
    return messages;
  }

  /**
   * Start real-time file watching for iMessage database changes.
   */
  static startRealTimeSync(): void {
    if (this.watcher?.isActive() === true) {
      console.log('[IMessageSync] Real-time sync already running');
      return;
    }

    if (!canStartRealTimeSync()) return;

    this.lastSyncRowId = initialRealTimeRowId();
    this.watcher = new IMessageWatcher(() => this.queryNewMessagesForWatcher());
    this.watcher.on('sync', (event: SyncEvent) => {
      handleSyncEvent(event).catch((err) => {
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
    const { newMaxRowId } = await runFullSync();
    if (newMaxRowId !== null && newMaxRowId > this.lastSyncRowId) {
      this.lastSyncRowId = newMaxRowId;
    }
  }

  /**
   * @deprecated Use SyncManager.startAll() instead. Kept for backward compat.
   */
  static startBackgroundSync(): void {
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
