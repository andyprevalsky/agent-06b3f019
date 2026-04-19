/**
 * sync-manager — service layer
 *
 * Business logic orchestration for the sync coordination domain:
 *   - IntegrationCache: TTL + in-flight deduping over the repo layer.
 *   - Per-platform sync orchestration helpers used by the runtime layer.
 *
 * Layer rule: service may import own repo, own types, own config, and shared
 * providers (here: main/base/* + sibling per-platform sync modules, which are
 * injected boundaries the blackbox test mocks).
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { AuthService } from '../../services/auth';
import { IMessageSync } from '../../services/iMessageSync';
import { CookieSync } from '../../services/cookieSync';
import { BrowserStateSync } from '../../services/browserStateSync';
import { TelegramSync } from '../../services/messaging/platforms/telegram/TelegramSync';
import { WhatsAppSync } from '../../services/messaging/platforms/whatsapp/WhatsAppSync';
import { PLATFORM_CONFIG, INTEGRATION_CACHE_TTL_MS } from './config';
import { fetchIntegrations } from './repo';
import type { CachedIntegrations, Integration, Platform, SyncConfig } from './types';

// ---------------------------------------------------------------------------
// IntegrationCache
// ---------------------------------------------------------------------------

/**
 * Centralized cache for integration statuses.
 * Avoids multiple API calls to GET /api/integrations per sync cycle.
 *
 * Usage:
 *   const isConnected = await IntegrationCache.isConnected('telegram');
 *   const connectedList = await IntegrationCache.getConnected();
 */
export class IntegrationCache {
  private static cache: CachedIntegrations | null = null;
  private static fetchPromise: Promise<CachedIntegrations> | null = null;

  /** Check if a specific integration is connected. */
  static async isConnected(integrationName: string): Promise<boolean> {
    const { connected } = await this.getIntegrations();
    return connected.has(integrationName);
  }

  /** Get set of all connected integration names. */
  static async getConnected(): Promise<Set<string>> {
    const { connected } = await this.getIntegrations();
    return connected;
  }

  /** Get full integration data for a specific integration. */
  static async getIntegration(integrationName: string): Promise<Integration | undefined> {
    const { all } = await this.getIntegrations();
    return all.find((i) => i.name === integrationName);
  }

  /**
   * Invalidate cache to force fresh fetch on next call.
   * Call this after connecting/disconnecting an integration.
   */
  static invalidate(): void {
    this.cache = null;
    this.fetchPromise = null;
    logConsole('IntegrationCache', 'Cache invalidated');
  }

  /**
   * Get integrations (from cache or fresh fetch).
   * Uses request deduplication to avoid parallel fetches.
   */
  private static async getIntegrations(): Promise<CachedIntegrations> {
    const now = Date.now();

    if (this.cache && now - this.cache.timestamp < INTEGRATION_CACHE_TTL_MS) {
      return this.cache;
    }

    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.refresh();

    try {
      const result = await this.fetchPromise;
      this.cache = result;
      return result;
    } finally {
      this.fetchPromise = null;
    }
  }

  /** Refresh the cache from the backend, falling back to the stale snapshot. */
  private static async refresh(): Promise<CachedIntegrations> {
    const session = await AuthService.getSession();
    if (!session) {
      logConsole('IntegrationCache', 'No session, returning empty');
      return { connected: new Set(), all: [], timestamp: Date.now() };
    }

    try {
      const result = await fetchIntegrations(session.access_token);
      if (!result.ok) {
        logConsoleError('IntegrationCache', 'Failed to fetch integrations', result.statusText);
        return this.cache ?? { connected: new Set(), all: [], timestamp: Date.now() };
      }

      const all = result.integrations;
      const connected = new Set(all.filter((i) => i.status !== 'NOT_CONNECTED').map((i) => i.name));

      logConsole(
        'IntegrationCache',
        `Fetched ${all.length} integrations, ${connected.size} connected`
      );

      return { connected, all, timestamp: Date.now() };
    } catch (error) {
      logConsoleError('IntegrationCache', 'Error fetching integrations', error);
      return this.cache ?? { connected: new Set(), all: [], timestamp: Date.now() };
    }
  }
}

// ---------------------------------------------------------------------------
// Per-platform sync orchestration
// ---------------------------------------------------------------------------

/**
 * Core sync logic for each platform. No integration check — caller has
 * already verified the platform is connected.
 */
export async function syncPlatformCore(platform: Platform): Promise<void> {
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
      // WhatsApp historical is limited, mainly real-time.
      break;

    case 'cookies':
      await CookieSync.sync();
      break;

    case 'browserState':
      await BrowserStateSync.sync();
      break;
  }
}

/**
 * Sync a specific platform, checking integration status first.
 */
export async function syncPlatform(platform: Platform): Promise<void> {
  const cfg = PLATFORM_CONFIG[platform];
  const connected = await IntegrationCache.getConnected();
  const isConnected = cfg.integrationNames.some((name) => connected.has(name));

  if (!isConnected) {
    logConsole('SyncManager', `Skipping ${platform} sync - not connected`);
    return;
  }

  await syncPlatformCore(platform);
}

/**
 * Fan out to every connected platform that has a non-zero interval.
 * Returns when every per-platform task has settled.
 */
export async function syncAllPlatforms(): Promise<void> {
  const session = await AuthService.getSession();
  if (!session) {
    logConsole('SyncManager', 'Skipping periodic sync - not authenticated');
    return;
  }

  const connected = await IntegrationCache.getConnected();
  const tasks: Promise<void>[] = [];

  for (const [platform, cfg] of Object.entries(PLATFORM_CONFIG) as [Platform, SyncConfig][]) {
    if (cfg.interval === 0) continue;
    const isConnected = cfg.integrationNames.some((name) => connected.has(name));
    if (!isConnected) continue;

    tasks.push(
      syncPlatformCore(platform).catch((err) =>
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
 * Run startup syncs for platforms that have syncOnStartup enabled.
 */
export async function runStartupSyncs(): Promise<void> {
  const session = await AuthService.getSession();
  if (!session) {
    logConsole('SyncManager', 'Skipping startup syncs - not authenticated');
    return;
  }

  const connected = await IntegrationCache.getConnected();
  logConsole(
    'SyncManager',
    `Connected integrations: ${Array.from(connected).join(', ') || 'none'}`
  );

  const tasks: Promise<void>[] = [];

  for (const [platform, cfg] of Object.entries(PLATFORM_CONFIG) as [Platform, SyncConfig][]) {
    if (!cfg.syncOnStartup) continue;
    const isConnected = cfg.integrationNames.some((name) => connected.has(name));
    if (!isConnected) continue;

    logConsole('SyncManager', `Running startup sync for ${platform}`);
    tasks.push(
      syncPlatformCore(platform).catch((err) =>
        logConsoleError('SyncManager', `Startup sync error for ${platform}`, err)
      )
    );
  }

  await Promise.allSettled(tasks);
  logConsole('SyncManager', 'Startup syncs complete');
}

/**
 * Connect Telegram real-time (MTProto) when session + API creds + integration
 * are all present, then kick off the initial historical sync.
 */
async function startTelegramRealTime(): Promise<void> {
  if (!PLATFORM_CONFIG.telegram.enableRealTime) return;

  const hasTelegramIntegration = await IntegrationCache.isConnected('telegram');
  if (!hasTelegramIntegration || !TelegramSync.hasSession() || !TelegramSync.hasApiCredentials()) {
    return;
  }

  try {
    const success = await TelegramSync.connectWithExistingSession();
    if (success) {
      logConsole('SyncManager', 'Telegram connected, syncing historical...');
      await TelegramSync.syncHistorical().catch((err) =>
        logConsoleError('SyncManager', 'Telegram historical sync error', err)
      );
    }
  } catch (err) {
    logConsoleError('SyncManager', 'Telegram connect error', err);
  }
}

/**
 * Connect WhatsApp real-time (Baileys) when credentials + integration are
 * present.
 */
async function startWhatsAppRealTime(): Promise<void> {
  if (!PLATFORM_CONFIG.whatsapp.enableRealTime) return;

  const hasWhatsAppIntegration = await IntegrationCache.isConnected('whatsapp');
  if (!hasWhatsAppIntegration || !WhatsAppSync.hasCredentials()) return;

  try {
    await WhatsAppSync.connect({ onQRCode: () => {} });
    logConsole('SyncManager', 'WhatsApp connected');
  } catch (err) {
    logConsoleError('SyncManager', 'WhatsApp connect error', err);
  }
}

/**
 * Start real-time watchers for every platform that supports them.
 */
export async function startRealTimeWatchers(): Promise<void> {
  if (PLATFORM_CONFIG.imessage.enableRealTime) {
    IMessageSync.startRealTimeSync();
    logConsole('SyncManager', 'Started iMessage real-time watcher');
  }
  await startTelegramRealTime();
  await startWhatsAppRealTime();
}

/**
 * Stop real-time watchers for every platform. Individual disconnect failures
 * are logged but do not prevent sibling platforms from stopping.
 */
export async function stopRealTimeWatchers(): Promise<void> {
  IMessageSync.stopRealTimeSync();
  await TelegramSync.disconnect().catch((err) =>
    logConsoleError('SyncManager', 'Error disconnecting Telegram', err)
  );
  await WhatsAppSync.disconnect().catch((err) =>
    logConsoleError('SyncManager', 'Error disconnecting WhatsApp', err)
  );
}
