/**
 * sync-manager — types layer
 *
 * All type aliases, interfaces, and enums for the sync coordination domain.
 * Layer rule: this file imports nothing from the project source tree.
 */

/**
 * Platforms coordinated by {@link SyncManager}.
 */
export type Platform =
  'imessage' | 'telegram' | 'whatsapp' | 'browserState' | 'compute' | 'userData';

/**
 * Configuration for a single sync platform.
 */
export interface SyncConfig {
  /** Periodic sync interval in ms (0 to disable) */
  interval: number;
  /** Enable real-time watching/events */
  enableRealTime: boolean;
  /** Sync immediately on startup */
  syncOnStartup: boolean;
  /** Integration name(s) to check in backend */
  integrationNames: string[];
}

/**
 * Sync event for real-time updates.
 */
export interface SyncEvent {
  platform: Platform;
  type: 'started' | 'completed' | 'failed';
  itemCount?: number;
  error?: string;
}

/**
 * A backend integration record as returned by GET /api/integrations.
 * Only fields actually consumed by this domain are declared.
 */
export interface Integration {
  name: string;
  /** Provider-side account id (`''` / absent = the legacy single-account row). */
  accountId?: string;
  status: string;
  isActive?: boolean;
  lastSyncAt?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Cached snapshot of integrations used by {@link IntegrationCache}.
 */
export interface CachedIntegrations {
  connected: Set<string>;
  all: Integration[];
  timestamp: number;
}
