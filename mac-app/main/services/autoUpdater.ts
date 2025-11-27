import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { config } from '../base/config';

let mainWindow: BrowserWindow | null = null;

export function initAutoUpdater(window: BrowserWindow) {
  mainWindow = window;

  // Don't check for updates in dev mode
  if (config.isDev) {
    console.log('[AutoUpdater] Skipping in dev mode');
    return;
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
    console.error('[AutoUpdater] Error:', error);
  });
}

export function checkForUpdates() {
  if (config.isDev) return;
  
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[AutoUpdater] Check failed:', err);
  });
}

