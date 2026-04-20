/**
 * sync-manager — runtime layer
 *
 * Thin public entry for the sync coordination domain. Exposes the
 * {@link SyncManager} static class, which the app wiring (main/index.ts and
 * main/handlers/registry.ts) starts on boot and stops on shutdown.
 *
 * Layer rule: runtime imports own service + own types + shared providers only.
 * No raw data access, no inline business logic.
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { IMessageQueueService } from '../../services/IMessageQueueService';
import { SYNC_INTERVAL_MS } from './config';
import {
  runStartupSyncs,
  startRealTimeWatchers,
  stopRealTimeWatchers,
  syncAllPlatforms,
  syncPlatform,
} from './service';
import type { Platform } from './types';

/**
 * Central coordinator for all data syncs.
 *
 * Features:
 * - Single startAll() entry point
 * - One periodic interval for all syncs
 * - Centralized integration status check (via IntegrationCache)
 * - Coordinates real-time watchers
 *
 * Usage:
 *   SyncManager.startAll();  // Called once on app startup
 *   SyncManager.stopAll();   // Called on app shutdown
 *   SyncManager.syncNow();   // Manual trigger
 */
export class SyncManager {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isRunning = false;

  /** Start all syncs — single entry point for app startup. */
  static async startAll(): Promise<void> {
    if (this.isRunning) {
      logConsole('SyncManager', 'Already running');
      return;
    }

    logConsole('SyncManager', 'Starting all syncs...');
    this.isRunning = true;

    await runStartupSyncs();
    this.startPeriodicDispatcher();
    await startRealTimeWatchers();
    IMessageQueueService.start();

    logConsole('SyncManager', 'All syncs started');
  }

  /** Stop all syncs. */
  static async stopAll(): Promise<void> {
    logConsole('SyncManager', 'Stopping all syncs...');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await stopRealTimeWatchers();
    IMessageQueueService.stop();

    this.isRunning = false;
    logConsole('SyncManager', 'All syncs stopped');
  }

  /** Trigger immediate sync for all platforms (or a specific one). */
  static async syncNow(platform?: Platform): Promise<void> {
    if (platform) {
      await syncPlatform(platform);
    } else {
      await syncAllPlatforms();
    }
  }

  /** Check if the sync manager is running. */
  static isActive(): boolean {
    return this.isRunning;
  }

  /** Start the single periodic interval that fans out to every platform. */
  private static startPeriodicDispatcher(): void {
    if (this.intervalId) return;

    logConsole('SyncManager', `Starting periodic sync (every ${SYNC_INTERVAL_MS / 1000 / 60} min)`);

    this.intervalId = setInterval(() => {
      syncAllPlatforms().catch((err) => logConsoleError('SyncManager', 'Periodic sync error', err));
    }, SYNC_INTERVAL_MS);
  }
}
