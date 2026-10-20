import type { BrowserWindow } from 'electron';
import { IMessageWatcher } from '../../services/messaging/platforms/imessage/IMessageWatcher';
import {
  canStartRealTimeSync,
  fetchNewMessagesSinceRowId,
  handleSyncEvent,
  initialRealTimeRowId,
} from './service';
import { runDeviceSync } from './service.run';
import type {
  DeviceSyncOutcome,
  NormalizedMessage,
  SyncEvent,
  SyncTrigger,
  UploadResult,
} from './types';

/** IPC channel the renderer listens on for upload progress (shared with the Uploader). */
const UPLOAD_PROGRESS_CHANNEL = 'upload:progress';

/**
 * Entry-point controller for the iMessage sync domain. Owns the long-lived
 * IMessageWatcher, the real-time ROWID cursor and the single in-flight device
 * sync (a scheduled tick and a user connect never run two loops over one
 * cursor). All business logic lives in ./service and ./service.run.
 */
export class IMessageSync {
  private static watcher: IMessageWatcher | null = null;
  private static lastSyncRowId: number = 0;
  private static inFlight: Promise<DeviceSyncOutcome> | null = null;

  private static async queryNewMessagesForWatcher(): Promise<NormalizedMessage[]> {
    const { messages, newMaxRowId } = await fetchNewMessagesSinceRowId(this.lastSyncRowId);
    this.lastSyncRowId = newMaxRowId;
    return messages;
  }

  private static async runOnce(
    trigger: SyncTrigger,
    onPercent?: (percent: number) => void
  ): Promise<DeviceSyncOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = runDeviceSync(trigger, onPercent);
    try {
      const result = await this.inFlight;
      if (result.upToRowId !== null && result.upToRowId > this.lastSyncRowId) {
        this.lastSyncRowId = result.upToRowId;
      }
      return result;
    } finally {
      this.inFlight = null;
    }
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
   * Scheduled device sync (periodic background sync and startup).
   */
  static async sync(): Promise<void> {
    await this.runOnce('scheduled');
  }

  /**
   * User-initiated connect: syncs this Mac into its own account (creating or
   * claiming it) and streams real progress to the renderer window.
   */
  static async connect(window: BrowserWindow | null): Promise<UploadResult> {
    const result = await this.runOnce('connect', (percent) => {
      window?.webContents.send(UPLOAD_PROGRESS_CHANNEL, { type: 'imessage', percent });
    });
    if (result.status === 'synced' || result.status === 'up_to_date') return { success: true };
    return { success: false, message: result.message ?? `iMessage sync ${result.status}` };
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
