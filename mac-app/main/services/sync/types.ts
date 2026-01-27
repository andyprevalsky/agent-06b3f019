/**
 * Platforms supported by SyncManager
 */
export type Platform = 'imessage' | 'telegram' | 'whatsapp' | 'cookies' | 'browserState';

/**
 * Configuration for a sync platform
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
 * Sync event for real-time updates
 */
export interface SyncEvent {
  platform: Platform;
  type: 'started' | 'completed' | 'failed';
  itemCount?: number;
  error?: string;
}
