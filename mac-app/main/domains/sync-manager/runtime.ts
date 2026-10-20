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
import { PhoneMirroring } from '../../services/phoneMirroring';
import { PLATFORM_CONFIG } from './config';
import {
  runStartupSyncs,
  startRealTimeWatchers,
  stopRealTimeWatchers,
  syncAllPlatforms,
  syncingWouldWriteToAnotherUser,
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
  private static intervalIds: NodeJS.Timeout[] = [];
  private static isRunning = false;
  private static lifecycleGeneration = 0;

  /** Start all syncs — single entry point for app startup. */
  static async startAll(): Promise<void> {
    if (this.isRunning) {
      logConsole('SyncManager', 'Already running');
      return;
    }
    if (await syncingWouldWriteToAnotherUser()) {
      logConsole('SyncManager', 'Not starting syncs: impersonating another account');
      return;
    }

    logConsole('SyncManager', 'Starting all syncs...');
    const generation = ++this.lifecycleGeneration;
    this.isRunning = true;

    await runStartupSyncs();
    if (!this.isRunning || generation !== this.lifecycleGeneration) return;
    this.startPeriodicDispatcher();
    await startRealTimeWatchers();
    if (!this.isRunning || generation !== this.lifecycleGeneration) {
      await stopRealTimeWatchers();
      return;
    }
    IMessageQueueService.start();
    // The attached iPhone (iPhone Mirroring) follows the same identity
    // boundary: started only for this Mac's own, non-impersonated session.
    PhoneMirroring.start();

    logConsole('SyncManager', 'All syncs started');
  }

  /** Stop all syncs. */
  static async stopAll(): Promise<void> {
    logConsole('SyncManager', 'Stopping all syncs...');
    this.lifecycleGeneration += 1;
    this.isRunning = false;

    for (const intervalId of this.intervalIds) {
      clearInterval(intervalId);
    }
    this.intervalIds = [];

    await stopRealTimeWatchers();
    IMessageQueueService.stop();
    PhoneMirroring.stop();

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

  /** Start periodic intervals for each platform at its configured cadence. */
  private static startPeriodicDispatcher(): void {
    if (this.intervalIds.length > 0) return;

    for (const [platform, cfg] of Object.entries(PLATFORM_CONFIG) as [
      Platform,
      (typeof PLATFORM_CONFIG)[Platform],
    ][]) {
      if (cfg.interval <= 0) continue;
      logConsole(
        'SyncManager',
        `Starting periodic ${platform} sync (every ${cfg.interval / 1000}s)`
      );
      const intervalId = setInterval(() => {
        syncPlatform(platform).catch((err) =>
          logConsoleError('SyncManager', `Periodic ${platform} sync error`, err)
        );
      }, cfg.interval);
      this.intervalIds.push(intervalId);
    }
  }
}
