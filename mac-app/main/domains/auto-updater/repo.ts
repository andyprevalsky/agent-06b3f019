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
import { config } from '../../base/config';
import { AuthService } from '../../services/auth';
import {
  buildFeedUrl,
  DOWNLOAD_TELEMETRY_ENDPOINT,
  DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS,
  DOWNLOAD_TELEMETRY_TIMEOUT_MS,
  FEED_PROVIDER,
} from './config';
import type {
  DownloadTelemetryPayload,
  DownloadTelemetryPostResult,
  UpdaterProgressInfo,
  UpdaterUpdateInfo,
} from './types';

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
  // Force full-zip downloads instead of block-level differential updates.
  // Differential download reconstructs the new artifact by reusing blocks from
  // whatever `Rose-mac.zip` is already in the updater cache. If that cached
  // artifact is stale (e.g. left over from a prior release whose blockmap no
  // longer matches the current feed), the reconstructed file fails its sha512
  // check and the whole update dies with a checksum-mismatch `error` event —
  // surfaced to the user as a bare "Update failed" with nothing in the renderer
  // console/network tab (the failure lives entirely in the main process).
  // Full downloads always re-fetch the complete zip and verify it end-to-end,
  // so they cannot be poisoned by a stale cache. On a generic HTTP feed the
  // bandwidth saving from differential updates is marginal; correctness wins.
  autoUpdater.disableDifferentialDownload = true;
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

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function isRetryableTelemetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Send one idempotent updater telemetry event through the authenticated backend.
 *
 * The insert ID is stable across retries, so Amplitude deduplicates an accepted
 * request whose response was lost. Missing auth is surfaced to the service as a
 * local diagnostic instead of making update installation depend on telemetry.
 */
export async function postDownloadTelemetry(
  payload: DownloadTelemetryPayload
): Promise<DownloadTelemetryPostResult> {
  const session = await AuthService.getSession();
  if (session === null) return { delivered: false, reason: 'unauthenticated' };

  const attempts = DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${config.apiUrl}${DOWNLOAD_TELEMETRY_ENDPOINT}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DOWNLOAD_TELEMETRY_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await wait(DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS[attempt] ?? 0);
      continue;
    }
    if (response.status === 202) return { delivered: true };
    const retryable = isRetryableTelemetryStatus(response.status);
    if (!retryable || attempt === attempts - 1) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Download telemetry rejected (${response.status}): ${detail}`);
    }
    await wait(DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS[attempt] ?? 0);
  }
  throw new Error('Download telemetry retry loop exhausted');
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
