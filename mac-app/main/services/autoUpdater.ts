import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog, MenuItem } from 'electron';
import { config } from '../base/config';

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;

function isMissingChannelFileError(err: unknown) {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || message.includes('latest-mac.yml');
}

export function isUpdateDownloaded() {
  return updateDownloaded;
}

export function restartToUpdate() {
  if (updateDownloaded) {
    autoUpdater.quitAndInstall();
  }
}

export function manualCheckForUpdates() {
  if (config.isDev) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Development Mode',
      message: 'Auto-updates are disabled in development mode.',
    });
    return;
  }
  
  autoUpdater.checkForUpdates().then((result) => {
    if (!result || !result.updateInfo) {
      dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'No Updates',
        message: 'You are running the latest version.',
      });
    }
  }).catch((err) => {
    if (isMissingChannelFileError(err)) {
      dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'No Updates Available Yet',
        message: 'A new build is still processing. Please try again in a few minutes.',
      });
      return;
    }
    console.error('[AutoUpdater] Manual check failed:', err);
    dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: 'Update Check Failed',
      message: `Could not check for updates: ${err.message}`,
    });
  });
}

export function initAutoUpdater(window: BrowserWindow) {
  mainWindow = window;

  // Don't check for updates in dev mode
  if (config.isDev) {
    console.log('[AutoUpdater] Skipping in dev mode');
    return;
  }

  // Configure for private GitHub repo
  const ghToken = process.env.GH_UPDATE_TOKEN;
  if (ghToken) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'andyprevalsky',
      repo: 'navi-whisper-lux',
      private: true,
      token: ghToken,
    });
  }

  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't auto-download, ask user first
  autoUpdater.autoInstallOnAppQuit = true;

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);

  // Check for updates every 4 hours
  setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);

  // Event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
  });

  autoUpdater.on('update-available', async (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available!`,
      detail: 'Would you like to download and install it now?',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[AutoUpdater] No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${Math.round(progress.percent)}%`);
    
    // Send progress to renderer if needed
    mainWindow?.webContents.send('update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    updateDownloaded = true;
    
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded!',
      detail: 'The update will be installed when you restart the app. Restart now?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    if (isMissingChannelFileError(error)) {
      console.warn('[AutoUpdater] Channel file missing, release likely still building.');
      return;
    }
    console.error('[AutoUpdater] Error:', error);
  });
}

export function checkForUpdates() {
  if (config.isDev) return;
  
  autoUpdater.checkForUpdates().catch((err) => {
    if (isMissingChannelFileError(err)) {
      console.warn('[AutoUpdater] Channel file missing, release likely still building.');
      return;
    }
    console.error('[AutoUpdater] Check failed:', err);
  });
}

