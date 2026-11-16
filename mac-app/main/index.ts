import { app, globalShortcut, Notification, type BrowserWindow } from 'electron';
import { config } from './base/config';
import {
  extractImportTokenFromActivityPayload,
  installCredentialExchangeActivityBridge,
  refreshCredentialExchangeActivityBridge,
} from './domains/passkey-import/activity-bridge';
import { importPasskeysFromToken } from './domains/passkey-import/service';
import { AuthService } from './domains/auth/runtime';
import {
  IMPERSONATED_MACHINE_DATA_MESSAGE,
  sessionForLocalMachineData,
} from './base/impersonation';
import { initLogger, logConsole, logConsoleError } from './base/logger';
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
import { startLocalCodeRunner } from './domains/local-code-runner/runtime';
import { startRoseCli } from './domains/rose-cli/runtime';
import { getErrorMessage } from '../shared/utils/error';

app.name = 'Rose';

// Dev-only: expose a Chrome DevTools Protocol endpoint so local tooling
// (playwright/Claude) can attach to the REAL window — screenshot it, drive it,
// verify which worktree's build is on screen. Never active in packaged builds;
// only when the launcher explicitly sets MAC_APP_DEBUG_PORT. Must be appended
// before app ready.
const debugPort = process.env.MAC_APP_DEBUG_PORT;
if (!app.isPackaged && debugPort !== undefined && debugPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

initLogger();
logConsole('Config', `Backend API URL: ${config.apiUrl}`);

const PROTOCOL = config.isDev ? 'roselabs-dev' : 'roselabs';

const enforceSingleInstance = !config.isDev;
const hasSingleInstanceLock = enforceSingleInstance ? app.requestSingleInstanceLock() : true;
if (enforceSingleInstance && !hasSingleInstanceLock) {
  logConsole('App', 'another Rose instance is already running; quitting duplicate');
  app.quit();
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
const quickQuery = new QuickQueryController({
  getMainWindow: () => mainWindow,
  openMainWindow: handleActivate,
  getOnboardingComplete,
});

registerDeepLinkProtocol(PROTOCOL);
registerOpenUrlHandler(() => mainWindow, openAppFromDeepLink);

console.log(`🚀 [Mac App] Mode: ${config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);

if (config.isDev) {
  process.stdin.resume();
  process.stdin.on('close', () => {
    console.log('[App] Shutting down: stdin closed (parent died)');
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      saveWindowState(mainWindow);
    }
    process.exit(0);
  });
}

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

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const wasVisible = mainWindow.isVisible();
  const wasMinimized = 'isMinimized' in mainWindow && mainWindow.isMinimized();
  const boundsBefore = mainWindow.getBounds();
  if ('isMinimized' in mainWindow && mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  logConsole('App', 'main window shown', {
    wasVisible,
    wasMinimized,
    boundsBefore,
    boundsAfter: mainWindow.getBounds(),
  });
}

function initializeWindowsAndIpc(): void {
  const window = buildMainWindow();
  quickQuery.createWindow();
  quickQuery.registerIpc();
  registerUpdateIpc();
  initAutoUpdater(window);
  showMainWindow();
}

function handleInitialDeepLink(): void {
  const deepLinkArg = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg !== undefined) {
    setTimeout(() => handleDeepLink(deepLinkArg, () => mainWindow, openAppFromDeepLink), 500);
  }
}

function initializeShortcuts(): void {
  if (getOnboardingComplete()) {
    quickQuery.registerGlobalShortcuts();
  } else {
    console.log('[App] Onboarding not complete - shortcuts disabled');
  }
}

void app
  .whenReady()
  .then(() => {
    logConsole('App', 'whenReady entered');
    initializeWindowsAndIpc();

    if (process.platform === 'darwin') {
      void app.dock.show();
    }

    createAppMenu();
    // C14: this Mac can run code agents in folders the user shares with Rose.
    startLocalCodeRunner();
    // The `rose` CLI ships with the app: (re)write ~/.rose/bin/rose for this app location.
    startRoseCli();
    IMessageReader.checkAccess();
    handleInitialDeepLink();
    initializeShortcuts();
    logConsole('App', 'whenReady startup complete');
  })
  .catch((error) => {
    logConsoleError('App', 'whenReady startup failed', error);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function handleActivate(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    const window = buildMainWindow();
    setAutoUpdaterWindow(window);
  }

  if (quickQuery.getWindow() === null) {
    quickQuery.createWindow();
  }

  showMainWindow();
}

function openAppFromDeepLink(agentId: string | null): void {
  if (!app.isReady()) {
    void app.whenReady().then(() => openAppFromDeepLink(agentId));
    return;
  }

  const mustWaitForRenderer = mainWindow === null || mainWindow.isDestroyed();
  handleActivate();
  const window = mainWindow;
  if (agentId === null || window === null || window.isDestroyed()) return;

  const selectAgent = () => {
    if (!window.isDestroyed()) window.webContents.send('open-agent', agentId);
  };
  // Main frame only: did-finish-load never fires again for an embedded
  // live-view frame that happens to be loading in an already-open window.
  if (mustWaitForRenderer || window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', selectAgent);
  } else {
    selectAgent();
  }
}

app.on('activate', () => {
  if (!app.isReady()) {
    void app.whenReady().then(handleActivate);
    return;
  }
  handleActivate();
});

app.on('second-instance', () => {
  logConsole('App', 'second instance requested; focusing existing Rose window');
  showMainWindow();
  refreshCredentialExchangeActivityBridge('second-instance');
});

app.on('will-quit', () => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  globalShortcut.unregisterAll();
});

// Apple Credential Exchange import: macOS delivers an import token when the user
// transfers credentials from Apple Passwords into Rose.
function extractImportToken(userInfo: Record<string, unknown>): string | null {
  return extractImportTokenFromActivityPayload({ userInfo });
}

function importNotificationBody(
  result: Awaited<ReturnType<typeof importPasskeysFromToken>>
): string {
  if (!result.success) {
    return `Import failed: ${result.message ?? 'unknown error'}`;
  }

  const passkeyCount = result.passkeyCount ?? result.count ?? 0;
  const passwordCount = result.passwordCount ?? 0;
  const passkeyLabel = `${passkeyCount} passkey${passkeyCount === 1 ? '' : 's'}`;
  const passwordLabel = `${passwordCount} password${passwordCount === 1 ? '' : 's'}`;
  return `Imported ${passkeyLabel} and ${passwordLabel}.`;
}

const handledCredentialImportTokens = new Set<string>();

async function runPasskeyImport(token: string): Promise<void> {
  const normalizedToken = token.toLowerCase();
  if (handledCredentialImportTokens.has(normalizedToken)) {
    logConsole('PasskeyImport', `ignoring duplicate import token=${token}`);
    return;
  }
  handledCredentialImportTokens.add(normalizedToken);

  try {
    logConsole('PasskeyImport', `starting import token=${token}`);
    const currentSession = await AuthService.getSession();
    const session = sessionForLocalMachineData(currentSession);
    if (!session) {
      const body =
        currentSession === null
          ? 'Sign in to import Apple Passwords.'
          : IMPERSONATED_MACHINE_DATA_MESSAGE;
      logConsole('PasskeyImport', `import blocked: ${body}`);
      new Notification({ title: 'Rose', body }).show();
      return;
    }
    const result = await importPasskeysFromToken(token, session.access_token);
    logConsole('PasskeyImport', 'import completed', result);
    mainWindow?.webContents.send('passkeys:importComplete', result);
    new Notification({
      title: 'Rose — Passwords',
      body: importNotificationBody(result),
    }).show();
  } catch (error) {
    const message = getErrorMessage(error);
    logConsole('PasskeyImport', `import failed: ${message}`);
    new Notification({
      title: 'Rose — Passwords',
      body: `Import failed: ${message}`,
    }).show();
  }
}

if (hasSingleInstanceLock) {
  installCredentialExchangeActivityBridge((token) => {
    void runPasskeyImport(token);
  });

  app.on('will-continue-activity', (event, type) => {
    logConsole('PasskeyImport', `will-continue-activity type=${type}`);
  });

  app.on('continue-activity', (event, type, userInfo, details) => {
    event.preventDefault();
    logConsole(
      'PasskeyImport',
      `continue-activity type=${type} keys=${Object.keys(userInfo ?? {}).join(',')} webpageURL=${details?.webpageURL ?? ''}`
    );
    const token = extractImportToken((userInfo ?? {}) as Record<string, unknown>);
    if (token !== null) {
      void runPasskeyImport(token);
    } else {
      logConsole('PasskeyImport', 'continue-activity did not contain an import token');
      new Notification({
        title: 'Rose — Passwords',
        body: 'Apple Passwords did not send Rose an import token.',
      }).show();
    }
  });

  app.on('continue-activity-error', (_event, type, error) => {
    logConsole('PasskeyImport', `continue-activity-error type=${type} error=${error}`);
    new Notification({
      title: 'Rose — Passwords',
      body: `Apple Passwords export failed: ${error}`,
    }).show();
  });
}
