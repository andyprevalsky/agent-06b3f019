import { app, globalShortcut, type BrowserWindow } from 'electron';
import { config } from './base/config';
import { getOnboardingComplete } from './handlers/registry';
import {
  initAutoUpdater,
  registerUpdateIpc,
  setAutoUpdaterWindow,
} from './domains/auto-updater/runtime';
import { IMessageReader } from './domains/i-message-reader/runtime';
import './domains/i-message-sync/runtime';
import { createAppMenu } from './app/appMenu';
import { handleDeepLink, registerDeepLinkProtocol, registerOpenUrlHandler } from './app/deepLinks';
import { createMainWindow } from './app/mainWindow';
import { QuickQueryController } from './app/quickQuery';
import { saveWindowState } from './app/windowState';

app.name = 'Rose';

const PROTOCOL = config.isDev ? 'roselabs-dev' : 'roselabs';

let mainWindow: BrowserWindow | null = null;
const quickQuery = new QuickQueryController({
  getMainWindow: () => mainWindow,
  getOnboardingComplete,
});

registerDeepLinkProtocol(PROTOCOL);
registerOpenUrlHandler(() => mainWindow);

console.log(`🚀 [Mac App] Mode: ${config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);

process.stdin.resume();
process.stdin.on('close', () => {
  console.log('[App] Shutting down: stdin closed (parent died)');
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  process.exit(0);
});

function buildMainWindow(): BrowserWindow {
  const window = createMainWindow({
    saveWindowState,
    onClosed: () => {
      mainWindow = null;
    },
  });
  mainWindow = window;
  return window;
}

function initializeWindowsAndIpc(): void {
  const window = buildMainWindow();
  quickQuery.createWindow();
  quickQuery.registerIpc();
  registerUpdateIpc();
  initAutoUpdater(window);
}

function handleInitialDeepLink(): void {
  const deepLinkArg = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg !== undefined) {
    setTimeout(() => handleDeepLink(deepLinkArg, () => mainWindow), 500);
  }
}

function initializeShortcuts(): void {
  if (getOnboardingComplete()) {
    quickQuery.registerGlobalShortcuts();
  } else {
    console.log('[App] Onboarding not complete - shortcuts disabled');
  }
}

void app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    void app.dock.show();
  }

  IMessageReader.checkAccess();
  createAppMenu();
  initializeWindowsAndIpc();
  handleInitialDeepLink();
  initializeShortcuts();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    const window = buildMainWindow();
    setAutoUpdaterWindow(window);
  }

  if (quickQuery.getWindow() === null) {
    quickQuery.createWindow();
  }
});

app.on('will-quit', () => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  globalShortcut.unregisterAll();
});
