import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import { config } from '../base/config';
import type { UpdateStatusPayload } from '../../shared/types/ipc';

const SUPABASE_UPDATE_URL = `${config.supabase.url}/storage/v1/object/public/Releases/mac/latest`;

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;
let pendingVersion: string | undefined;
let ipcRegistered = false;

function isMissingChannelFileError(err: unknown) {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || message.includes('latest-mac.yml');
}

function sendStatus(status: UpdateStatusPayload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:status', {
    ...status,
    version: status.version ?? pendingVersion,
  });
}

function sendProgress(percent: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:progress', { percent });
}

export function isUpdateDownloaded() {
  return updateDownloaded;
}

export function restartToUpdate() {
  if (updateDownloaded) {
    // isSilent: false = show install progress
    // isForceRunAfter: true = restart app after install
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  }
}

export async function manualCheckForUpdates() {
  await runCheck();
}

export function setAutoUpdaterWindow(window: BrowserWindow) {
  mainWindow = window;
}

export function initAutoUpdater(window: BrowserWindow) {
  mainWindow = window;

  if (config.isDev) {
    console.log('[AutoUpdater] Skipping in dev mode');
    sendStatus({ state: 'idle' });
    return;
  }

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: SUPABASE_UPDATE_URL,
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Wait for renderer to fully load so IPC listeners are attached before sending status
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates(), 500);
  });

  setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
    sendStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    pendingVersion = info.version;
    sendStatus({ state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[AutoUpdater] No updates available');
    pendingVersion = undefined;
    sendStatus({ state: 'none' });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    console.log(`[AutoUpdater] Download progress: ${percent}%`);
    sendProgress(progress.percent);
    sendStatus({
      state: 'downloading',
      percent: progress.percent,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    updateDownloaded = true;
    pendingVersion = info.version;
    sendStatus({ state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (error) => {
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

    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[AutoUpdater] Error:', error);
    sendStatus({ state: 'error', message });
  });
}

async function runCheck() {
  if (config.isDev) {
    sendStatus({
      state: 'error',
      message: 'Auto-updates are disabled in development mode.',
    });
    return;
  }

  sendStatus({ state: 'checking' });

  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      sendStatus({ state: 'none' });
    }
  } catch (err) {
    if (isMissingChannelFileError(err)) {
      // Treat missing channel file as "up to date"
      sendStatus({ state: 'none' });
      return;
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    sendStatus({ state: 'error', message });
    console.error('[AutoUpdater] Check failed:', err);
  }
}

export function checkForUpdates() {
  runCheck();
}

export async function downloadUpdate() {
  if (config.isDev) return;

  try {
    sendStatus({ state: 'downloading' });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    // Don't show error if download actually succeeded
    if (updateDownloaded) {
      return;
    }

    if (isMissingChannelFileError(err)) {
      sendStatus({ state: 'none' });
      return;
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    sendStatus({ state: 'error', message });
    console.error('[AutoUpdater] Download failed:', err);
  }
}

export function registerUpdateIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('updates:check', async () => {
    await manualCheckForUpdates();
    return { success: true };
  });

  ipcMain.handle('updates:download', async () => {
    await downloadUpdate();
    return { success: true };
  });

  ipcMain.handle('updates:install', async () => {
    restartToUpdate();
    return { success: true };
  });
}

