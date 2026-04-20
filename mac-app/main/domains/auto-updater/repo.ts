/**
 * auto-updater — repo layer
 *
 * Data-access / external-system layer for the auto-updater domain. Wraps
 * electron-updater so the rest of the domain never imports the SDK directly.
 *
 * Layer rule: repo imports own types/config and provider packages only
 * (electron-updater). No business logic — every function is a thin pass-through.
 */

import { autoUpdater } from 'electron-updater';
import { buildFeedUrl, FEED_PROVIDER } from './config';
import type { UpdaterProgressInfo, UpdaterUpdateInfo } from './types';

/**
 * Configure the electron-updater feed against the Supabase Releases bucket
 * and disable auto-download so the renderer controls when bytes are pulled.
 */
export function configureFeed(): void {
  autoUpdater.setFeedURL({
    provider: FEED_PROVIDER,
    url: buildFeedUrl(),
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
}

/** Proxy for `autoUpdater.checkForUpdates()` — typed result passthrough. */
export async function checkForUpdatesRaw(): Promise<{ updateInfo?: UpdaterUpdateInfo } | null> {
  const result = await autoUpdater.checkForUpdates();
  return result as { updateInfo?: UpdaterUpdateInfo } | null;
}

/** Proxy for `autoUpdater.downloadUpdate()`. */
export async function downloadUpdateRaw(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

/**
 * Proxy for `autoUpdater.quitAndInstall(isSilent, isForceRunAfter)`.
 * The service layer picks the flag values based on the desired UX.
 */
export function quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
  autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
}

/**
 * Typed listener surface for the subset of events this domain translates.
 * Declared as an interface so service-level handlers stay strictly typed.
 */
export interface UpdaterListeners {
  onCheckingForUpdate: () => void;
  onUpdateAvailable: (info: UpdaterUpdateInfo) => void;
  onUpdateNotAvailable: () => void;
  onDownloadProgress: (info: UpdaterProgressInfo) => void;
  onUpdateDownloaded: (info: UpdaterUpdateInfo) => void;
  onError: (error: unknown) => void;
}

/** Register every event listener the service needs in one call. */
export function registerListeners(listeners: UpdaterListeners): void {
  autoUpdater.on('checking-for-update', listeners.onCheckingForUpdate);
  autoUpdater.on('update-available', listeners.onUpdateAvailable);
  autoUpdater.on('update-not-available', listeners.onUpdateNotAvailable);
  autoUpdater.on('download-progress', listeners.onDownloadProgress);
  autoUpdater.on('update-downloaded', listeners.onUpdateDownloaded);
  autoUpdater.on('error', listeners.onError);
}

/**
 * Classify a thrown error as "latest-mac.yml is missing from the feed".
 * Surfaces both the typed error code and the substring fallback used when
 * electron-updater stringifies the failure without a code.
 */
export function isMissingChannelFileError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || message.includes('latest-mac.yml');
}
