import { AuthService } from '../auth';
import { IMessageSync } from '../iMessageSync';
import { CookieSync } from '../cookieSync';
import { BrowserStateSync } from '../browserStateSync';
import { TelegramSync } from '../messaging/platforms/telegram/TelegramSync';
import { WhatsAppSync } from '../messaging/platforms/whatsapp/WhatsAppSync';
import { ClaudeCredentialSync } from '../claudeCredentialSync';
import { IMessageQueueService } from '../IMessageQueueService';
import { IntegrationCache } from './IntegrationCache';
import { logConsole, logConsoleError } from '../../base/logger';

type Platform = 'imessage' | 'telegram' | 'whatsapp' | 'cookies' | 'browserState' | 'claudeCode';

interface SyncConfig {
  /** Periodic sync interval in ms (0 to disable) */
  interval: number;
  /** Enable real-time watching/events */
  enableRealTime: boolean;
  /** Sync immediately on startup */
  syncOnStartup: boolean;
  /** Integration name(s) to check in backend */
  integrationNames: string[];
}

const CONFIG: Record<Platform, SyncConfig> = {
  imessage: {
    interval: 5 * 60 * 1000,  // 5 minutes
    enableRealTime: true,      // fs.watch on chat.db
    syncOnStartup: true,
    integrationNames: ['imessage'],
  },
  telegram: {
    interval: 5 * 60 * 1000,
    enableRealTime: true,      // MTProto events
    syncOnStartup: true,       // Sync historical after connect
    integrationNames: ['telegram'],
  },
  whatsapp: {
    interval: 5 * 60 * 1000,
    enableRealTime: true,      // Baileys events
    syncOnStartup: false,      // Limited historical due to Baileys v7
    integrationNames: ['whatsapp'],
  },
  cookies: {
    interval: 5 * 60 * 1000,
    enableRealTime: false,
    syncOnStartup: true,
    integrationNames: ['chrome'],  // Legacy cookie integration
  },
  browserState: {
    interval: 5 * 60 * 1000,
    enableRealTime: false,
    syncOnStartup: true,
    integrationNames: ['chrome', 'edge', 'brave', 'arc', 'opera', 'vivaldi', 'chromium', 'atlas', 'safari', 'firefox'],
  },
  claudeCode: {
    interval: 5 * 60 * 1000,
    enableRealTime: false,
    syncOnStartup: true,
    integrationNames: ['claude_code'],
  },
};

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
  private static readonly SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Start all syncs - single entry point for app startup.
   */
  static async startAll(): Promise<void> {
    if (this.isRunning) {
      logConsole('SyncManager', 'Already running');
      return;
    }

    logConsole('SyncManager', 'Starting all syncs...');
    this.isRunning = true;

    // 1. Run startup syncs
    await this.runStartupSyncs();

    // 2. Start periodic sync dispatcher
    this.startPeriodicDispatcher();

    // 3. Start real-time watchers
    await this.startRealTimeWatchers();

    // 4. Start iMessage queue polling (for agent-sent messages)
    IMessageQueueService.start();

    logConsole('SyncManager', 'All syncs started');
  }

  /**
   * Stop all syncs.
   */
  static async stopAll(): Promise<void> {
    logConsole('SyncManager', 'Stopping all syncs...');

    // Stop periodic sync
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Stop real-time watchers
    IMessageSync.stopRealTimeSync();
    await TelegramSync.disconnect().catch(err =>
      logConsoleError('SyncManager', 'Error disconnecting Telegram', err)
    );
    await WhatsAppSync.disconnect().catch(err =>
      logConsoleError('SyncManager', 'Error disconnecting WhatsApp', err)
    );

    // Stop iMessage queue polling
    IMessageQueueService.stop();

    this.isRunning = false;
    logConsole('SyncManager', 'All syncs stopped');
  }

  /**
   * Trigger immediate sync for all platforms (or specific one).
   */
  static async syncNow(platform?: Platform): Promise<void> {
    if (platform) {
      await this.syncPlatform(platform);
    } else {
      await this.syncAllPlatforms();
    }
  }

  /**
   * Run startup syncs for platforms that have syncOnStartup enabled.
   */
  private static async runStartupSyncs(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      logConsole('SyncManager', 'Skipping startup syncs - not authenticated');
      return;
    }

    // Get connected integrations once
    const connected = await IntegrationCache.getConnected();
    logConsole('SyncManager', `Connected integrations: ${Array.from(connected).join(', ') || 'none'}`);

    const tasks: Promise<void>[] = [];

    for (const [platform, cfg] of Object.entries(CONFIG) as [Platform, SyncConfig][]) {
      if (!cfg.syncOnStartup) continue;

      // Check if any of the integration names are connected
      const isConnected = cfg.integrationNames.some(name => connected.has(name));
      if (!isConnected) continue;

      logConsole('SyncManager', `Running startup sync for ${platform}`);
      tasks.push(
        this.syncPlatformCore(platform).catch(err =>
          logConsoleError('SyncManager', `Startup sync error for ${platform}`, err)
        )
      );
    }

    await Promise.allSettled(tasks);
    logConsole('SyncManager', 'Startup syncs complete');
  }

  /**
   * Start single periodic interval that dispatches to all platforms.
   */
  private static startPeriodicDispatcher(): void {
    if (this.intervalId) return;

    logConsole('SyncManager', `Starting periodic sync (every ${this.SYNC_INTERVAL_MS / 1000 / 60} min)`);

    this.intervalId = setInterval(() => {
      this.syncAllPlatforms().catch(err =>
        logConsoleError('SyncManager', 'Periodic sync error', err)
      );
    }, this.SYNC_INTERVAL_MS);
  }

  /**
   * Start real-time watchers for platforms that support it.
   */
  private static async startRealTimeWatchers(): Promise<void> {
    // iMessage: fs.watch on chat.db
    if (CONFIG.imessage.enableRealTime) {
      IMessageSync.startRealTimeSync();
      logConsole('SyncManager', 'Started iMessage real-time watcher');
    }

    // Telegram: connect with existing session (MTProto events)
    // Only connect if there's a backend integration - local session alone is not enough
    if (CONFIG.telegram.enableRealTime) {
      const hasTelegramIntegration = await IntegrationCache.isConnected('telegram');
      if (hasTelegramIntegration && TelegramSync.hasSession() && TelegramSync.hasApiCredentials()) {
        try {
          const success = await TelegramSync.connectWithExistingSession();
          if (success) {
            logConsole('SyncManager', 'Telegram connected, syncing historical...');
            // Sync historical after connecting
            await TelegramSync.syncHistorical().catch(err =>
              logConsoleError('SyncManager', 'Telegram historical sync error', err)
            );
          }
        } catch (err) {
          logConsoleError('SyncManager', 'Telegram connect error', err);
        }
      }
    }

    // WhatsApp: connect with existing credentials (Baileys events)
    // Only connect if there's a backend integration
    if (CONFIG.whatsapp.enableRealTime) {
      const hasWhatsAppIntegration = await IntegrationCache.isConnected('whatsapp');
      if (hasWhatsAppIntegration && WhatsAppSync.hasCredentials()) {
        try {
          await WhatsAppSync.connect({ onQRCode: () => {} });
          logConsole('SyncManager', 'WhatsApp connected');
        } catch (err) {
          logConsoleError('SyncManager', 'WhatsApp connect error', err);
        }
      }
    }
  }

  /**
   * Sync all platforms (called by periodic dispatcher).
   */
  private static async syncAllPlatforms(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      logConsole('SyncManager', 'Skipping periodic sync - not authenticated');
      return;
    }

    // Get connected integrations once for this cycle
    const connected = await IntegrationCache.getConnected();

    const tasks: Promise<void>[] = [];

    for (const [platform, cfg] of Object.entries(CONFIG) as [Platform, SyncConfig][]) {
      if (cfg.interval === 0) continue;

      // Check if any of the integration names are connected
      const isConnected = cfg.integrationNames.some(name => connected.has(name));
      if (!isConnected) continue;

      tasks.push(
        this.syncPlatformCore(platform).catch(err =>
          logConsoleError('SyncManager', `Sync error for ${platform}`, err)
        )
      );
    }

    if (tasks.length === 0) {
      logConsole('SyncManager', 'No connected integrations to sync');
      return;
    }

    logConsole('SyncManager', `Syncing ${tasks.length} platform(s)...`);
    await Promise.allSettled(tasks);
    logConsole('SyncManager', 'Periodic sync complete');
  }

  /**
   * Sync a specific platform (public method, checks integration status).
   */
  private static async syncPlatform(platform: Platform): Promise<void> {
    const cfg = CONFIG[platform];
    const connected = await IntegrationCache.getConnected();
    const isConnected = cfg.integrationNames.some(name => connected.has(name));

    if (!isConnected) {
      logConsole('SyncManager', `Skipping ${platform} sync - not connected`);
      return;
    }

    await this.syncPlatformCore(platform);
  }

  /**
   * Core sync logic for each platform (no integration check - caller verified).
   */
  private static async syncPlatformCore(platform: Platform): Promise<void> {
    switch (platform) {
      case 'imessage':
        await IMessageSync.sync();
        break;

      case 'telegram':
        if (TelegramSync.isConnected()) {
          await TelegramSync.syncHistorical();
        }
        break;

      case 'whatsapp':
        // WhatsApp historical is limited, mainly real-time
        // Could add WhatsAppSync.syncHistorical() if implemented
        break;

      case 'cookies':
        await CookieSync.sync();
        break;

      case 'browserState':
        await BrowserStateSync.sync();
        break;

      case 'claudeCode':
        if (ClaudeCredentialSync.hasCredentials()) {
          await ClaudeCredentialSync.syncCredentials();
        }
        break;
    }
  }

  /**
   * Check if sync manager is running.
   */
  static isActive(): boolean {
    return this.isRunning;
  }
}
