import { app, BrowserWindow, nativeImage, globalShortcut, ipcMain, screen, Menu } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { config } from './base/config';
import './handlers/registry'; // Register IPC handlers
import { getOnboardingComplete } from './handlers/registry';
import {
  initAutoUpdater,
  manualCheckForUpdates,
  restartToUpdate,
  isUpdateDownloaded,
  registerUpdateIpc,
} from './services/autoUpdater';

app.name = 'Rose';

// Register custom URL scheme for deep links (e.g., roselabs://payment-success)
// Use roselabs-dev in dev to avoid conflicts with production app
// Must be called before app.ready on macOS
const PROTOCOL = config.isDev ? 'roselabs-dev' : 'roselabs';

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

console.log(`[App] Registered protocol: ${PROTOCOL}://`)

// Handle deep link URLs (roselabs://...)
function handleDeepLink(url: string) {
  console.log('[App] Received deep link:', url);
  try {
    const parsed = new URL(url);
    if (parsed.host === 'payment-success') {
      console.log('[App] Payment success deep link received');
      // Send to renderer to complete onboarding
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('payment-complete', { success: true });
      }
    } else if (parsed.host === 'payment-cancel') {
      console.log('[App] Payment cancel deep link received');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('payment-complete', { success: false });
      }
    }
  } catch (err) {
    console.error('[App] Failed to parse deep link URL:', err);
  }
}

// Handle deep link on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Log environment mode at startup
console.log(`🚀 [Mac App] Mode: ${config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);

// Window state persistence
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const windowStateStore = new Store<{ mainWindow?: WindowState }>({
  name: 'window-state',
  defaults: {},
});

function getWindowState(): WindowState {
  const saved = windowStateStore.get('mainWindow');
  return saved || { width: 1800, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  windowStateStore.set('mainWindow', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  });
}

let mainWindow: BrowserWindow | null = null;
let quickQueryWindow: BrowserWindow | null = null;
let quickQueryBlurEnabled = false;
let quickQueryLastHiddenAt = 0;
let quickQueryShownAt = 0; // Track when window was shown for 1s hide protection
let quickQueryFocusTimeouts: NodeJS.Timeout[] = [];

// Listen for parent process death (stdin close) - quit when Conductor dies
// Use process.exit(0) instead of app.quit() because app.quit() can hang on macOS
process.stdin.resume();
process.stdin.on('close', () => {
  console.log('[App] Shutting down: stdin closed (parent died)');
  // Save window state before exiting since process.exit() bypasses close events
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  process.exit(0);
});

function getIconPaths() {
  const iconBasePath = config.isDev
    ? path.join(__dirname, '../../../assets/icons')
    : path.join(__dirname, '../assets/icons');
  const macIcnsPath = path.join(iconBasePath, 'app.icns');
  const macPngPath = path.join(iconBasePath, 'app.png');

  return {
    macIcnsPath,
    macPngPath,
    iconPath: process.platform === 'darwin'
      ? (config.isDev ? macPngPath : macIcnsPath)
      : macPngPath,
  };
}

function createMainWindow() {
  const { iconPath, macIcnsPath, macPngPath } = getIconPaths();
  const windowState = getWindowState();

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 1500,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Restore maximized state
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Set dock icon for macOS (BrowserWindow icon is ignored on macOS)
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(config.isDev ? macPngPath : macIcnsPath);
    app.dock.setIcon(icon);
  }

  if (config.isDev) {
    mainWindow.loadURL('http://localhost:5174');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../ui/index.html'));
  }

  // Save window state on resize/move
  mainWindow.on('resize', () => saveWindowState(mainWindow!));
  mainWindow.on('move', () => saveWindowState(mainWindow!));
  mainWindow.on('close', () => saveWindowState(mainWindow!));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createQuickQueryWindow() {
  quickQueryWindow = new BrowserWindow({
    width: 500,
    height: 100,
    minWidth: 500,
    maxWidth: 500,
    minHeight: 100,
    maxHeight: 100,
    useContentSize: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Force content size to ensure window is exactly 500x100
  quickQueryWindow.setContentSize(500, 100);
  quickQueryWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickQueryWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    quickQueryWindow.setWindowButtonVisibility(false);
  }

  if (config.isDev) {
    quickQueryWindow.loadURL('http://localhost:5174/launcher.html');
  } else {
    quickQueryWindow.loadFile(path.join(__dirname, '../../ui/launcher.html'));
  }

  // Debug: log actual window sizes after load
  quickQueryWindow.webContents.once('did-finish-load', () => {
    const size = quickQueryWindow?.getSize();
    const contentSize = quickQueryWindow?.getContentSize();
    const bounds = quickQueryWindow?.getBounds();
    console.log('[QuickQuery] Window size:', size);
    console.log('[QuickQuery] Content size:', contentSize);
    console.log('[QuickQuery] Bounds:', bounds);
  });

  quickQueryWindow.on('blur', () => {
    if (quickQueryBlurEnabled) {
      hideQuickQueryWindow();
    }
  });

  quickQueryWindow.on('focus', () => {
    // Window gained focus - blur handler can be enabled
  });

  quickQueryWindow.on('closed', () => {
    quickQueryWindow = null;
  });
}

function emitQuickQueryToggle(open: boolean) {
  if (!quickQueryWindow || quickQueryWindow.isDestroyed()) return;
  const send = () => quickQueryWindow?.webContents.send('quick-query:toggle', { open });

  if (quickQueryWindow.webContents.isLoading()) {
    quickQueryWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function positionQuickQueryWindow() {
  if (!quickQueryWindow) return;
  const cursorPoint = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
  const [width] = quickQueryWindow.getSize();
  const workArea = targetDisplay.workArea ?? targetDisplay.bounds;

  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height * 0.8)); // Lower on screen
  quickQueryWindow.setPosition(x, y, false);
}

function showQuickQueryWindow() {
  if (!quickQueryWindow) return;

  // Don't show quick launcher during onboarding
  if (!getOnboardingComplete()) {
    console.log('[QuickQuery] Blocked show - onboarding not complete');
    return;
  }

  // Debounce: ignore show requests within 2 seconds of hiding
  const timeSinceHide = Date.now() - quickQueryLastHiddenAt;
  if (timeSinceHide < 2000) {
    return;
  }

  quickQueryBlurEnabled = false; // Disable blur while showing
  quickQueryShownAt = Date.now(); // Track show time for 1s hide protection

  positionQuickQueryWindow();

  // Ensure app has focus before showing window (helps on macOS)
  app.focus({ steal: true });

  quickQueryWindow.show();
  quickQueryWindow.focus();
  quickQueryWindow.focusOnWebView();

  // Clear any pending focus timeouts from previous show
  quickQueryFocusTimeouts.forEach(t => clearTimeout(t));
  quickQueryFocusTimeouts = [];

  // Aggressively grab focus multiple times to beat other apps
  const focusAttempts = [10, 50, 100, 150, 300, 500, 1000];
  focusAttempts.forEach((delay) => {
    const timeout = setTimeout(() => {
      if (quickQueryWindow && !quickQueryWindow.isDestroyed()) {
        app.focus({ steal: true });
        quickQueryWindow.moveTop();
        quickQueryWindow.focus();
        quickQueryWindow.focusOnWebView();
        quickQueryWindow.webContents.focus();

        // Send a synthetic mouse click to the input area to capture keyboard focus
        const bounds = quickQueryWindow.getBounds();
        quickQueryWindow.webContents.sendInputEvent({
          type: 'mouseDown',
          x: Math.round(bounds.width / 2),
          y: Math.round(bounds.height / 2),
          button: 'left',
          clickCount: 1,
        });
        quickQueryWindow.webContents.sendInputEvent({
          type: 'mouseUp',
          x: Math.round(bounds.width / 2),
          y: Math.round(bounds.height / 2),
          button: 'left',
          clickCount: 1,
        });

        // Also focus the input directly via JS
        quickQueryWindow.webContents.executeJavaScript(`
          const input = document.querySelector('input');
          if (input) {
            input.click();
            input.focus();
          }
        `).catch(() => {});
      }
    }, delay);
    quickQueryFocusTimeouts.push(timeout);
  });

  emitQuickQueryToggle(true);

  // Enable blur after a short delay (root-level 5s protection handles ChatGPT)
  setTimeout(() => {
    quickQueryBlurEnabled = true;
  }, 200);
}

function hideQuickQueryWindow({ focusMain }: { focusMain?: boolean } = {}) {
  if (!quickQueryWindow) return;

  // FORCED VISIBLE: Block ALL hide attempts for 1 second after showing
  const timeSinceShow = Date.now() - quickQueryShownAt;
  if (timeSinceShow < 1000) {
    return;
  }

  // Cancel all pending focus timeouts to prevent them from re-showing the window
  quickQueryFocusTimeouts.forEach(t => clearTimeout(t));
  quickQueryFocusTimeouts = [];

  quickQueryBlurEnabled = false; // Disable blur when hiding
  quickQueryLastHiddenAt = Date.now(); // Record hide time to debounce show
  if (!quickQueryWindow.isDestroyed()) {
    quickQueryWindow.hide();
    emitQuickQueryToggle(false);
  }

  if (focusMain && mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

let shortcutsEnabled = false;

function registerGlobalShortcuts() {
  // Don't register if already enabled
  if (shortcutsEnabled) return;

  const toggleQuickQuery = () => {
    if (!quickQueryWindow) return;

    // Don't toggle quick launcher during onboarding
    if (!getOnboardingComplete()) {
      console.log('[QuickQuery] Blocked - onboarding not complete');
      return;
    }

    if (quickQueryWindow.isVisible()) {
      // Note: hideQuickQueryWindow will be blocked for 1s after show (FORCED VISIBLE)
      hideQuickQueryWindow({ focusMain: true });
    } else {
      showQuickQueryWindow();
    }
  };

  // Try to register Alt+Space - if it fails (another app has it), fall back to Alt+Shift+Space only
  const altSpaceRegistered = globalShortcut.register('Alt+Space', toggleQuickQuery);
  if (!altSpaceRegistered) {
    console.log('[App] Alt+Space shortcut is already taken by another app');
  }

  globalShortcut.register('Alt+Shift+Space', toggleQuickQuery);
  shortcutsEnabled = true;
  console.log('[App] Global shortcuts registered');
}

function unregisterGlobalShortcuts() {
  if (!shortcutsEnabled) return;
  globalShortcut.unregisterAll();
  shortcutsEnabled = false;
  console.log('[App] Global shortcuts unregistered');
}

function registerQuickQueryIpc() {
  ipcMain.handle('quick-query:submit', (_event, payload) => {
    const queryPayload = typeof payload === 'string'
      ? { query: payload, submittedAt: Date.now() }
      : {
          query: payload?.query ?? '',
          submittedAt: payload?.submittedAt ?? Date.now(),
        };

    hideQuickQueryWindow({ focusMain: true });

    if (mainWindow && queryPayload.query.trim()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('quick-query:submit', queryPayload);
    }

    return { success: true };
  });

  ipcMain.handle('quick-query:hide', () => {
    hideQuickQueryWindow({ focusMain: true });
    return { success: true };
  });

  // Enable/disable shortcuts (used during onboarding)
  ipcMain.handle('shortcut:enable', () => {
    registerGlobalShortcuts();
    return { success: true, enabled: shortcutsEnabled };
  });

  ipcMain.handle('shortcut:disable', () => {
    unregisterGlobalShortcuts();
    return { success: true, enabled: shortcutsEnabled };
  });

  ipcMain.handle('shortcut:isEnabled', () => {
    return { enabled: shortcutsEnabled };
  });
}

function createAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => manualCheckForUpdates(),
        },
        {
          label: 'Restart to Update',
          click: () => restartToUpdate(),
          enabled: isUpdateDownloaded(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.show();
  }

  createAppMenu();
  createMainWindow();
  createQuickQueryWindow();
  registerQuickQueryIpc();
  registerUpdateIpc();

  // Handle deep link if app was launched via URL (app was closed)
  // On macOS, the URL is passed via process.argv when launched from closed state
  const deepLinkArg = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg) {
    // Small delay to ensure renderer is ready
    setTimeout(() => handleDeepLink(deepLinkArg), 500);
  }

  // Only register global shortcuts if onboarding is complete
  // During onboarding, shortcuts are disabled so user can configure them
  const onboardingComplete = getOnboardingComplete();
  if (onboardingComplete) {
    registerGlobalShortcuts();
  } else {
    console.log('[App] Onboarding not complete - shortcuts disabled');
  }

  // Initialize auto-updater
  if (mainWindow) {
    initAutoUpdater(mainWindow);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }

  if (!quickQueryWindow) {
    createQuickQueryWindow();
  }
});

app.on('will-quit', () => {
  // Save window state before quitting as a safety net
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  globalShortcut.unregisterAll();
});

