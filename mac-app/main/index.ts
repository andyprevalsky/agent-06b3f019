import { app, BrowserWindow, nativeImage, globalShortcut, ipcMain, screen, Menu } from 'electron';
import path from 'path';
import { config } from './base/config';
import './handlers/registry'; // Register IPC handlers
import {
  initAutoUpdater,
  manualCheckForUpdates,
  restartToUpdate,
  isUpdateDownloaded,
  registerUpdateIpc,
} from './services/autoUpdater';

app.name = 'Rose';

let mainWindow: BrowserWindow | null = null;
let quickQueryWindow: BrowserWindow | null = null;

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

  mainWindow = new BrowserWindow({
    width: 1800,
    height: 800,
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

  // Set dock icon for macOS (BrowserWindow icon is ignored on macOS)
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(config.isDev ? macPngPath : macIcnsPath);
    app.dock.setIcon(icon);
  }

  if (config.isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../ui/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createQuickQueryWindow() {
  quickQueryWindow = new BrowserWindow({
    width: 500,
    minHeight: 100,
    height: 100,
    maxHeight: 400,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    alwaysOnTop: true,
    vibrancy: 'under-window',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  quickQueryWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickQueryWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    quickQueryWindow.setWindowButtonVisibility(false);
  }

  if (config.isDev) {
    quickQueryWindow.loadURL('http://localhost:5173/launcher.html');
  } else {
    quickQueryWindow.loadFile(path.join(__dirname, '../../ui/launcher.html'));
  }

  quickQueryWindow.on('blur', () => {
    hideQuickQueryWindow();
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
  positionQuickQueryWindow();
  quickQueryWindow.show();
  quickQueryWindow.focus();
  emitQuickQueryToggle(true);
}

function hideQuickQueryWindow({ focusMain }: { focusMain?: boolean } = {}) {
  if (!quickQueryWindow) return;
  if (!quickQueryWindow.isDestroyed()) {
    quickQueryWindow.hide();
    emitQuickQueryToggle(false);
  }

  if (focusMain && mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function registerGlobalShortcuts() {
  globalShortcut.register('Alt+Shift+Space', () => {
    if (!quickQueryWindow) return;
    if (quickQueryWindow.isVisible()) {
      hideQuickQueryWindow({ focusMain: true });
    } else {
      showQuickQueryWindow();
    }
  });
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
  registerGlobalShortcuts();
  registerQuickQueryIpc();
  registerUpdateIpc();
  
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
  globalShortcut.unregisterAll();
});

