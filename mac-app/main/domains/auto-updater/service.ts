/**
 * auto-updater — service layer
 *
 * Business logic for the auto-updater domain:
 *   - Owns the renderer-facing state machine (idle → checking → available →
 *     downloading → downloaded | error | none).
 *   - Translates raw electron-updater events into {@link UpdateStatusPayload}s
 *     sent over `mainWindow.webContents.send(...)`.
 *   - Suppresses errors that arrive after `update-downloaded` so the renderer
 *     never regresses from a "downloaded" state to an error state.
 *
 * Layer rule: service may import own repo, own types, own config, and the
 * shared config provider. It never touches electron-updater directly — all
 * SDK calls go through the repo layer.
 */

import type { BrowserWindow } from 'electron';
import { config } from '../../base/config';
import { getErrorMessage } from '../../../shared/utils/error';
import { DEV_MODE_ERROR_MESSAGE, IPC_CHANNELS } from './config';
import {
  checkForUpdatesRaw,
  downloadUpdateRaw,
  isMissingChannelFileError,
  quitAndInstall,
  registerListeners,
} from './repo';
import type { UpdaterProgressInfo, UpdaterUpdateInfo, UpdateStatusPayload } from './types';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;
let pendingVersion: string | undefined;

// ---------------------------------------------------------------------------
// Window routing
// ---------------------------------------------------------------------------

/** Set the window that receives `update:*` messages. */
export function setWindow(window: BrowserWindow): void {
  mainWindow = window;
}

/** Has an update been fully downloaded and staged for install? */
export function isUpdateDownloaded(): boolean {
  return updateDownloaded;
}

// ---------------------------------------------------------------------------
// Renderer dispatch
// ---------------------------------------------------------------------------

function sendStatus(status: UpdateStatusPayload): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.status, {
    ...status,
    version: status.version ?? pendingVersion,
  });
}

function sendProgress(percent: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.progress, { percent });
}

/** Emit a synthetic idle status — used during init when in dev mode. */
export function emitIdle(): void {
  sendStatus({ state: 'idle' });
}

// ---------------------------------------------------------------------------
// Event handlers — registered on electron-updater via the repo layer
// ---------------------------------------------------------------------------

function handleCheckingForUpdate(): void {
  console.log('[AutoUpdater] Checking for updates...');
  sendStatus({ state: 'checking' });
}

function handleUpdateAvailable(info: UpdaterUpdateInfo): void {
  console.log('[AutoUpdater] Update available:', info.version);
  pendingVersion = info.version;
  sendStatus({ state: 'available', version: info.version });
}

function handleUpdateNotAvailable(): void {
  console.log('[AutoUpdater] No updates available');
  pendingVersion = undefined;
  sendStatus({ state: 'none' });
}

function handleDownloadProgress(progress: UpdaterProgressInfo): void {
  const percent = Math.round(progress.percent);
  console.log(`[AutoUpdater] Download progress: ${percent}%`);
  sendProgress(progress.percent);
  sendStatus({ state: 'downloading', percent: progress.percent });
}

function handleUpdateDownloaded(info: UpdaterUpdateInfo): void {
  console.log('[AutoUpdater] Update downloaded:', info.version);
  updateDownloaded = true;
  pendingVersion = info.version;
  sendStatus({ state: 'downloaded', version: info.version });
}

function handleError(error: unknown): void {
  // Don't overwrite downloaded state with error
  if (updateDownloaded) {
    console.warn('[AutoUpdater] Ignoring error after download completed');
    return;
  }

  if (isMissingChannelFileError(error)) {
    console.warn('[AutoUpdater] Channel file missing, treating as up to date.');
    sendStatus({ state: 'none' });
    return;
  }

  console.error('[AutoUpdater] Error:', error);
  sendStatus({ state: 'error', message: getErrorMessage(error) });
}

/** Register every electron-updater listener this domain cares about. */
export function attachUpdaterListeners(): void {
  registerListeners({
    onCheckingForUpdate: handleCheckingForUpdate,
    onUpdateAvailable: handleUpdateAvailable,
    onUpdateNotAvailable: handleUpdateNotAvailable,
    onDownloadProgress: handleDownloadProgress,
    onUpdateDownloaded: handleUpdateDownloaded,
    onError: handleError,
  });
}

// ---------------------------------------------------------------------------
// Manual control — check / download / restart
// ---------------------------------------------------------------------------

/**
 * Run a manual update check. Emits `{ state: 'error', ... }` in dev mode,
 * `{ state: 'none' }` when electron-updater returns no updateInfo or when the
 * feed's channel file is missing, and `{ state: 'error', message }` on any
 * other throw.
 */
export async function runManualCheck(): Promise<void> {
  if (config.isDev) {
    sendStatus({ state: 'error', message: DEV_MODE_ERROR_MESSAGE });
    return;
  }

  sendStatus({ state: 'checking' });

  try {
    const result = await checkForUpdatesRaw();
    if (!result || !result.updateInfo) {
      sendStatus({ state: 'none' });
    }
  } catch (err) {
    if (isMissingChannelFileError(err)) {
      sendStatus({ state: 'none' });
      return;
    }
    sendStatus({ state: 'error', message: getErrorMessage(err) });
    console.error('[AutoUpdater] Check failed:', err);
  }
}

/**
 * Trigger a download. Emits `{ state: 'downloading' }` first, then defers to
 * electron-updater. Missing-channel-file errors collapse to `{ state: 'none' }`,
 * and errors that arrive after a successful `update-downloaded` are swallowed.
 */
export async function runDownload(): Promise<void> {
  if (config.isDev) return;

  try {
    sendStatus({ state: 'downloading' });
    await downloadUpdateRaw();
  } catch (err) {
    if (updateDownloaded) return;

    if (isMissingChannelFileError(err)) {
      sendStatus({ state: 'none' });
      return;
    }

    sendStatus({ state: 'error', message: getErrorMessage(err) });
    console.error('[AutoUpdater] Download failed:', err);
  }
}

/**
 * Quit the app and install the pending update. No-op if no update has been
 * downloaded yet. Scheduled via `setImmediate` so the IPC reply flushes first.
 */
export function runRestart(): void {
  if (!updateDownloaded) return;
  setImmediate(() => {
    // isSilent=false shows the installer progress UI.
    // isForceRunAfter=true re-launches the app after the update.
    quitAndInstall(false, true);
  });
}
