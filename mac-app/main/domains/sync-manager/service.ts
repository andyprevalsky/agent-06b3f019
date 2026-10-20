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

import { basename, dirname } from 'path';
import { existsSync, watch, type FSWatcher } from 'fs';
import { logConsole, logConsoleError } from '../../base/logger';
import { AuthService } from '../../services/auth';
import { accessTokenIsImpersonated } from '../../base/impersonation';
import { IMessageSync } from '../../services/iMessageSync';
import { BrowserStateSync } from '../../services/browserStateSync';
import { ClaudeCredentialSync } from '../../services/claudeCredentialSync';
import { CODEX_AUTH_PATH, GptCredentialSync } from '../../services/gptCredentialSync';
import { UserDataSync } from '../../services/userDataSync';
import { TelegramSync } from '../../services/messaging/platforms/telegram/TelegramSync';
import { WhatsAppSync } from '../../services/messaging/platforms/whatsapp/WhatsAppSync';
import { PLATFORM_CONFIG, INTEGRATION_CACHE_TTL_MS } from './config';
import { fetchIntegrations } from './repo';
import type { CachedIntegrations, Integration, Platform, SyncConfig } from './types';

let codexAuthWatcher: FSWatcher | null = null;
let codexAuthDebounce: NodeJS.Timeout | null = null;

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

  /** Every account row of one provider (multi-account providers have one per account). */
  static async getAccounts(integrationName: string): Promise<Integration[]> {
    const { all } = await this.getIntegrations();
    return all.filter((i) => i.name === integrationName);
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
async function syncComputeCredentials(connected?: Set<string>): Promise<void> {
  // Reachable directly (not only via syncPlatformCore), so it repeats the guard:
  // uploading the operator's Claude/Codex credentials into an impersonated
  // account would hand that account the operator's provider access.
  if (await syncingWouldWriteToAnotherUser()) {
    logConsole('SyncManager', 'Skipping compute credential sync: impersonating another account');
    return;
  }
  const synced: Promise<unknown>[] = [];
  if (connected === undefined || connected.has('claude_code')) {
    synced.push(ClaudeCredentialSync.syncExistingCredentialsIfChanged());
  }
  if (connected === undefined || connected.has('gpt_code')) {
    synced.push(GptCredentialSync.syncExistingCredentialsIfChanged());
  }
  if (synced.length === 0) return;
  await Promise.allSettled(synced);
}

/**
 * Whether outbound syncing must be suppressed because an admin is viewing another
 * user's account. Reads the CURRENT session token, so it re-evaluates on every
 * sync rather than caching a stale answer across a switch.
 */
export async function syncingWouldWriteToAnotherUser(): Promise<boolean> {
  const session = await AuthService.getSession();
  return accessTokenIsImpersonated(session?.access_token);
}

export async function syncPlatformCore(platform: Platform, connected?: Set<string>): Promise<void> {
  // HARD STOP. Every branch below uploads data harvested from THIS machine —
  // the operator's iMessage, WhatsApp, browser cookies/passwords, and compute
  // credentials — authenticated as the current session. While impersonating,
  // that session is the target user, so syncing here would write the admin's
  // personal data into someone else's account. Unlike a UI bug this is not
  // recoverable after the fact, so it is refused rather than reconciled.
  if (await syncingWouldWriteToAnotherUser()) {
    logConsole('SyncManager', `Skipping ${platform} sync: impersonating another account`);
    return;
  }

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

    case 'browserState':
      await BrowserStateSync.sync();
      break;

    case 'compute':
      await syncComputeCredentials(connected);
      break;

    case 'userData':
      await UserDataSync.sync(connected);
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

  await syncPlatformCore(platform, connected);
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
      syncPlatformCore(platform, connected).catch((err) =>
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
      syncPlatformCore(platform, connected).catch((err) =>
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

function scheduleCodexAuthFileSync(filename: string | Buffer | null): void {
  if (filename !== null && filename.toString() !== basename(CODEX_AUTH_PATH)) return;
  if (codexAuthDebounce) clearTimeout(codexAuthDebounce);
  codexAuthDebounce = setTimeout(() => {
    void IntegrationCache.isConnected('gpt_code')
      .then((connected) => {
        if (!connected) return undefined;
        return GptCredentialSync.syncExistingCredentialsIfChanged();
      })
      .catch((err) => logConsoleError('SyncManager', 'Codex credential watcher sync error', err));
  }, 250);
}

function startComputeRealTime(): void {
  if (!PLATFORM_CONFIG.compute.enableRealTime || codexAuthWatcher !== null) return;

  const authDir = dirname(CODEX_AUTH_PATH);
  if (!existsSync(authDir)) {
    logConsole('SyncManager', `Codex auth watcher skipped - missing directory: ${authDir}`);
    return;
  }

  try {
    codexAuthWatcher = watch(authDir, (_eventType, filename) => {
      scheduleCodexAuthFileSync(filename);
    });
    codexAuthWatcher.on('error', (err) =>
      logConsoleError('SyncManager', 'Codex auth watcher error', err)
    );
    logConsole('SyncManager', `Started Codex auth watcher for ${CODEX_AUTH_PATH}`);
  } catch (err) {
    codexAuthWatcher = null;
    logConsoleError('SyncManager', 'Failed to start Codex auth watcher', err);
  }
}

/**
 * Start real-time watchers for every platform that supports them.
 */
export async function startRealTimeWatchers(): Promise<void> {
  // Real-time watchers stream this machine's messages/credentials outward as they
  // change, so arming them while impersonating leaks the operator's data into the
  // target account continuously rather than once.
  if (await syncingWouldWriteToAnotherUser()) {
    logConsole('SyncManager', 'Not starting real-time watchers: impersonating another account');
    return;
  }
  if (PLATFORM_CONFIG.imessage.enableRealTime) {
    IMessageSync.startRealTimeSync();
    logConsole('SyncManager', 'Started iMessage real-time watcher');
  }
  const connected = await IntegrationCache.getConnected();
  if (
    PLATFORM_CONFIG.userData.enableRealTime &&
    PLATFORM_CONFIG.userData.integrationNames.some((name) => connected.has(name))
  ) {
    await UserDataSync.startRealTimeSync(connected);
    logConsole('SyncManager', 'Started user-data real-time watchers');
  }
  startComputeRealTime();
  await startTelegramRealTime();
  await startWhatsAppRealTime();
}

/**
 * Stop real-time watchers for every platform. Individual disconnect failures
 * are logged but do not prevent sibling platforms from stopping.
 */
export async function stopRealTimeWatchers(): Promise<void> {
  IMessageSync.stopRealTimeSync();
  if (codexAuthDebounce) {
    clearTimeout(codexAuthDebounce);
    codexAuthDebounce = null;
  }
  if (codexAuthWatcher) {
    codexAuthWatcher.close();
    codexAuthWatcher = null;
  }
  UserDataSync.stopRealTimeSync();
  await TelegramSync.disconnect().catch((err) =>
    logConsoleError('SyncManager', 'Error disconnecting Telegram', err)
  );
  await WhatsAppSync.disconnect().catch((err) =>
    logConsoleError('SyncManager', 'Error disconnecting WhatsApp', err)
  );
}
