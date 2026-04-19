/**
 * sync-manager — config layer
 *
 * Constants and defaults for the sync coordination domain.
 * Layer rule: config may import from own types only.
 */

import type { Platform, SyncConfig } from './types';

/** IntegrationCache TTL — how long a backend snapshot stays valid. */
export const INTEGRATION_CACHE_TTL_MS = 30 * 1000;

/** Periodic sync tick — how often SyncManager fans out to every platform. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Per-platform sync configuration. */
export const PLATFORM_CONFIG: Record<Platform, SyncConfig> = {
  imessage: {
    interval: 5 * 60 * 1000, // 5 minutes
    enableRealTime: true, // fs.watch on chat.db
    syncOnStartup: true,
    integrationNames: ['imessage'],
  },
  telegram: {
    interval: 5 * 60 * 1000,
    enableRealTime: true, // MTProto events
    syncOnStartup: true, // Sync historical after connect
    integrationNames: ['telegram'],
  },
  whatsapp: {
    interval: 5 * 60 * 1000,
    enableRealTime: true, // Baileys events
    syncOnStartup: false, // Limited historical due to Baileys v7
    integrationNames: ['whatsapp'],
  },
  cookies: {
    interval: 5 * 60 * 1000,
    enableRealTime: false,
    syncOnStartup: true,
    integrationNames: ['chrome'], // Legacy cookie integration
  },
  browserState: {
    interval: 5 * 60 * 1000,
    enableRealTime: false,
    syncOnStartup: true,
    integrationNames: [
      'chrome',
      'edge',
      'brave',
      'arc',
      'opera',
      'vivaldi',
      'chromium',
      'atlas',
      'safari',
      'firefox',
    ],
  },
  // claudeCode sync disabled — token is managed manually via update-claude-token.ts
};
