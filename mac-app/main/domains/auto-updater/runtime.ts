/**
 * auto-updater — runtime layer
 *
 * Public entry points for the auto-updater domain. Owns IPC registration and
 * the boot-time init flow; all state mutation and event translation lives in
 * the service layer.
 *
 * Layer rule: runtime imports own service + own config + providers (electron)
 * only. No direct electron-updater calls, no inline business logic.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { config } from '../../base/config';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, IPC_CHANNELS } from './config';
import {
  attachUpdaterListeners,
  emitIdle,
  isUpdateDownloaded,
  runDownload,
  runManualCheck,
  runRestart,
  setWindow,
} from './service';
import { configureFeed } from './repo';

let ipcRegistered = false;

/** Re-export the service's window setter so existing callers keep the name. */
export function setAutoUpdaterWindow(window: BrowserWindow): void {
  setWindow(window);
}

/** Re-export the service's downloaded-state probe. */
export { isUpdateDownloaded };

/**
 * Initialize the auto-updater. In dev mode this emits a single idle status
 * and exits — no feed is configured, no listeners are registered, no check
 * is scheduled. In packaged builds it wires electron-updater, registers event
 * translators, schedules the first check after `did-finish-load + 500ms`, and
 * starts the 4-hour periodic timer.
 */
export function initAutoUpdater(window: BrowserWindow): void {
  setWindow(window);

  if (config.isDev) {
    console.log('[AutoUpdater] Skipping in dev mode');
    emitIdle();
    return;
  }

  configureFeed();

  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      checkForUpdates();
    }, FIRST_CHECK_DELAY_MS);
  });

  setInterval(() => {
    checkForUpdates();
  }, CHECK_INTERVAL_MS);

  attachUpdaterListeners();
}

/**
 * Fire-and-forget update check — kept as a plain function so the periodic
 * interval and the `did-finish-load` timer don't need to await it.
 */
export function checkForUpdates(): void {
  void runManualCheck();
}

/** Promise-returning variant for the manual IPC handler. */
export async function manualCheckForUpdates(): Promise<void> {
  await runManualCheck();
}

/** Promise-returning wrapper so IPC handlers can await the download. */
export async function downloadUpdate(): Promise<void> {
  await runDownload();
}

/** Restart and install if an update has been downloaded — no-op otherwise. */
export function restartToUpdate(): void {
  runRestart();
}

/**
 * Register the renderer-facing IPC surface: `updates:check`, `updates:download`,
 * `updates:install`. Guarded so repeated calls are no-ops (idempotent init).
 */
export function registerUpdateIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(IPC_CHANNELS.check, async () => {
    await manualCheckForUpdates();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.download, async () => {
    await downloadUpdate();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.install, () => {
    restartToUpdate();
    return { success: true };
  });
}
