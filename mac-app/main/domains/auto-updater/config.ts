/**
 * auto-updater — config layer
 *
 * Constants and URL builders for the auto-updater domain.
 * Layer rule: config may import from own types and the shared base config
 * provider only.
 */

import { config } from '../../base/config';

/** electron-updater feed provider — "generic" uses a plain HTTP bucket. */
export const FEED_PROVIDER = 'generic' as const;

/**
 * Build the Supabase Storage feed URL for the mac channel. Evaluated on
 * demand so tests can mock `config.supabase.url` before init.
 */
export function buildFeedUrl(): string {
  return `${config.supabase.url}/storage/v1/object/public/Releases/mac/latest`;
}

/** Delay between `did-finish-load` and the first update check (ms). */
export const FIRST_CHECK_DELAY_MS = 500;

/** Interval between background update checks (ms) — 4 hours. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** User-visible error when update checks are attempted in dev mode. */
export const DEV_MODE_ERROR_MESSAGE = 'Auto-updates are disabled in development mode.';

/** IPC channels the runtime exposes to the renderer. */
export const IPC_CHANNELS = {
  status: 'update:status',
  progress: 'update:progress',
  check: 'updates:check',
  download: 'updates:download',
  install: 'updates:install',
} as const;
