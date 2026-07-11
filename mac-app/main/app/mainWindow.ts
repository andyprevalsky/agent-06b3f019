import { app, BrowserWindow, nativeImage, screen, shell } from 'electron';
import path from 'path';
import { config } from '../base/config';
import { getPackagedIconBasePath, getPackagedRendererPath } from './packagedPaths';
import { getWindowState, type WindowState } from './windowState';

interface IconPaths {
  iconPath: string;
  macIcnsPath: string;
  macPngPath: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CreateMainWindowOptions {
  saveWindowState: (win: BrowserWindow) => void;
  onClosed: () => void;
}

function getIconPaths(): IconPaths {
  const iconBasePath = config.isDev
    ? path.join(__dirname, '../../../assets/icons')
    : getPackagedIconBasePath();
  const macIcnsPath = path.join(iconBasePath, 'app.icns');
  const macPngPath = path.join(iconBasePath, 'app.png');

  return {
    macIcnsPath,
    macPngPath,
    iconPath:
      process.platform === 'darwin' ? (config.isDev ? macPngPath : macIcnsPath) : macPngPath,
  };
}

function getDevRendererUrl(pathname = ''): string {
  const port = process.env.MAC_APP_PORT ?? '5174';
  return `http://localhost:${port}${pathname}`;
}

function getAppOrigin(): string {
  return config.isDev ? getDevRendererUrl() : 'file://';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function getCurrentWorkAreas(): Rect[] {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const displayWorkAreas = screen.getAllDisplays().map((display) => display.workArea);
  const workAreas = displayWorkAreas.length > 0 ? displayWorkAreas : [primaryWorkArea];

  if (!workAreas.some((area) => area === primaryWorkArea)) {
    workAreas.unshift(primaryWorkArea);
  }

  return workAreas;
}

export function getVisibleWindowState(windowState = getWindowState()): Required<WindowState> {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const workAreas = getCurrentWorkAreas();
  const savedX = windowState.x;
  const savedY = windowState.y;
  const savedTopLeftArea =
    isFiniteNumber(savedX) && isFiniteNumber(savedY)
      ? workAreas.find((area) => containsPoint(area, savedX, savedY))
      : undefined;
  const hasUsableSavedPosition =
    windowState.isMaximized !== true &&
    savedTopLeftArea !== undefined &&
    isFiniteNumber(savedX) &&
    isFiniteNumber(savedY);
  const targetArea = hasUsableSavedPosition ? savedTopLeftArea : primaryWorkArea;
  const width = Math.min(Math.max(windowState.width, 900), targetArea.width);
  const height = Math.min(Math.max(windowState.height, 600), targetArea.height);

  return {
    x: hasUsableSavedPosition
      ? clamp(savedX, targetArea.x, targetArea.x + targetArea.width - width)
      : targetArea.x,
    y: hasUsableSavedPosition
      ? clamp(savedY, targetArea.y, targetArea.y + targetArea.height - height)
      : targetArea.y,
    width,
    height,
    isMaximized: false,
  };
}

function installNavigationGuards(mainWindow: BrowserWindow): void {
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(getAppOrigin())) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

export function createMainWindow({
  saveWindowState,
  onClosed,
}: CreateMainWindowOptions): BrowserWindow {
  const { iconPath, macIcnsPath, macPngPath } = getIconPaths();
  const windowState = getVisibleWindowState();
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workArea;

  const mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: Math.min(900, screenWidth),
    minHeight: Math.min(600, screenHeight),
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The preload is compiled by tsc as a small CommonJS module graph.
      // Electron's sandbox preload loader cannot resolve those local files.
      sandbox: false,
      webviewTag: true,
      preload: path.join(__dirname, '../preload.js'),
    },
  });

  if (windowState.isMaximized === true) {
    mainWindow.maximize();
  }

  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(config.isDev ? macPngPath : macIcnsPath);
    app.dock.setIcon(icon);
  }

  if (config.isDev) {
    void mainWindow.loadURL(getDevRendererUrl());
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    void mainWindow.loadFile(getPackagedRendererPath('index.html'));
  }

  installNavigationGuards(mainWindow);

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', onClosed);

  return mainWindow;
}
