import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import path from 'path';
import { config } from '../base/config';
import { getPackagedRendererPath } from './packagedPaths';
import { normalizeQuickQueryPayload } from './quickQueryPayload';
import type { QuickQueryResizePayload } from '../../shared/types/ipc';

const LAUNCHER_WINDOW_WIDTH = 500;
const LAUNCHER_WINDOW_HEIGHT = 100;
const LAUNCHER_WINDOW_MAX_HEIGHT = 480;

interface QuickQueryControllerOptions {
  getMainWindow: () => BrowserWindow | null;
  getOnboardingComplete: () => boolean;
}

export class QuickQueryController {
  private quickQueryWindow: BrowserWindow | null = null;
  private blurEnabled = false;
  private lastHiddenAt = 0;
  private shownAt = 0;
  private focusTimeouts: NodeJS.Timeout[] = [];
  private shortcutsEnabled = false;

  constructor(private readonly options: QuickQueryControllerOptions) {}

  getWindow(): BrowserWindow | null {
    return this.quickQueryWindow;
  }

  createWindow(): BrowserWindow {
    this.quickQueryWindow = new BrowserWindow({
      width: LAUNCHER_WINDOW_WIDTH,
      height: LAUNCHER_WINDOW_HEIGHT,
      minWidth: LAUNCHER_WINDOW_WIDTH,
      maxWidth: LAUNCHER_WINDOW_WIDTH,
      minHeight: LAUNCHER_WINDOW_HEIGHT,
      maxHeight: LAUNCHER_WINDOW_MAX_HEIGHT,
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
        // The preload is compiled by tsc as a small CommonJS module graph.
        // Electron's sandbox preload loader cannot resolve those local files.
        sandbox: false,
        preload: path.join(__dirname, '../preload.js'),
      },
    });

    this.configureWindow(this.quickQueryWindow);
    return this.quickQueryWindow;
  }

  registerIpc(): void {
    ipcMain.handle('quick-query:submit', (_event, payload: unknown) => {
      const queryPayload = normalizeQuickQueryPayload(payload);
      this.hideWindow({ focusMain: true });

      const mainWindow = this.options.getMainWindow();
      const hasContent =
        queryPayload.query.trim().length > 0 || (queryPayload.attachments?.length ?? 0) > 0;
      if (mainWindow !== null && hasContent) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('quick-query:submit', queryPayload);
      }

      return { success: true };
    });

    ipcMain.handle('quick-query:hide', () => {
      this.hideWindow({ focusMain: true });
      return { success: true };
    });

    ipcMain.handle('quick-query:resize', (_event, payload: unknown) => {
      return this.resizeWindow(payload);
    });

    ipcMain.handle('shortcut:enable', () => {
      this.registerGlobalShortcuts();
      return { success: true, enabled: this.shortcutsEnabled };
    });

    ipcMain.handle('shortcut:disable', () => {
      this.unregisterGlobalShortcuts();
      return { success: true, enabled: this.shortcutsEnabled };
    });

    ipcMain.handle('shortcut:isEnabled', () => {
      return { enabled: this.shortcutsEnabled };
    });
  }

  registerGlobalShortcuts(): void {
    if (this.shortcutsEnabled) return;

    const toggleQuickQuery = () => {
      const quickWindow = this.quickQueryWindow;
      if (quickWindow === null) return;

      if (this.options.getOnboardingComplete() !== true) {
        console.log('[QuickQuery] Blocked - onboarding not complete');
        return;
      }

      if (quickWindow.isVisible()) {
        this.hideWindow({ focusMain: true });
      } else {
        this.showWindow();
      }
    };

    const altSpaceRegistered = globalShortcut.register('Alt+Space', toggleQuickQuery);
    if (!altSpaceRegistered) {
      console.log('[App] Alt+Space shortcut is already taken by another app');
    }

    globalShortcut.register('Alt+Shift+Space', toggleQuickQuery);
    this.shortcutsEnabled = true;
    console.log('[App] Global shortcuts registered');
  }

  unregisterGlobalShortcuts(): void {
    if (!this.shortcutsEnabled) return;
    globalShortcut.unregisterAll();
    this.shortcutsEnabled = false;
    console.log('[App] Global shortcuts unregistered');
  }

  private configureWindow(quickWindow: BrowserWindow): void {
    this.applyWindowHeight(quickWindow, LAUNCHER_WINDOW_HEIGHT);
    quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    quickWindow.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      quickWindow.setWindowButtonVisibility(false);
    }

    if (config.isDev) {
      void quickWindow.loadURL(this.getDevLauncherUrl());
    } else {
      void quickWindow.loadFile(getPackagedRendererPath('launcher.html'));
    }

    quickWindow.webContents.once('did-finish-load', () => {
      console.log('[QuickQuery] Window size:', quickWindow.getSize());
      console.log('[QuickQuery] Content size:', quickWindow.getContentSize());
      console.log('[QuickQuery] Bounds:', quickWindow.getBounds());
    });

    quickWindow.on('blur', () => {
      if (this.blurEnabled) {
        this.hideWindow();
      }
    });

    quickWindow.on('focus', () => undefined);
    quickWindow.on('closed', () => {
      this.quickQueryWindow = null;
    });
  }

  private showWindow(): void {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null) return;

    if (this.options.getOnboardingComplete() !== true) {
      console.log('[QuickQuery] Blocked show - onboarding not complete');
      return;
    }

    if (Date.now() - this.lastHiddenAt < 2000) {
      return;
    }

    this.blurEnabled = false;
    this.shownAt = Date.now();
    this.applyWindowHeight(quickWindow, LAUNCHER_WINDOW_HEIGHT);
    this.positionWindow(quickWindow);
    app.focus({ steal: true });
    quickWindow.show();
    quickWindow.focus();
    quickWindow.focusOnWebView();
    this.clearFocusTimeouts();
    this.scheduleFocusAttempts(quickWindow);
    this.emitToggle(true);

    setTimeout(() => {
      this.blurEnabled = true;
    }, 200);
  }

  private hideWindow({ focusMain }: { focusMain?: boolean } = {}): void {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null) return;

    if (Date.now() - this.shownAt < 1000) {
      return;
    }

    this.clearFocusTimeouts();
    this.blurEnabled = false;
    this.lastHiddenAt = Date.now();
    if (!quickWindow.isDestroyed()) {
      quickWindow.hide();
      this.emitToggle(false);
    }

    const mainWindow = this.options.getMainWindow();
    if (focusMain === true && mainWindow !== null) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  private emitToggle(open: boolean): void {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null || quickWindow.isDestroyed()) return;
    const send = () => quickWindow.webContents.send('quick-query:toggle', { open });

    if (quickWindow.webContents.isLoading()) {
      quickWindow.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  }

  private positionWindow(quickWindow: BrowserWindow): void {
    const cursorPoint = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const [width] = quickWindow.getSize();
    const workArea = targetDisplay.workArea ?? targetDisplay.bounds;
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + workArea.height * 0.8);
    quickWindow.setPosition(x, y, false);
  }

  private scheduleFocusAttempts(quickWindow: BrowserWindow): void {
    for (const delay of [10, 50, 100, 150, 300, 500, 1000]) {
      const timeout = setTimeout(() => {
        if (quickWindow.isDestroyed()) return;
        app.focus({ steal: true });
        quickWindow.moveTop();
        quickWindow.focus();
        quickWindow.focusOnWebView();
        quickWindow.webContents.focus();
        this.clickWindowCenter(quickWindow);
        void quickWindow.webContents
          .executeJavaScript(
            `
          const input = document.querySelector('textarea, input');
          if (input) {
            input.click();
            input.focus();
          }
        `
          )
          .catch(() => undefined);
      }, delay);
      this.focusTimeouts.push(timeout);
    }
  }

  private clickWindowCenter(quickWindow: BrowserWindow): void {
    const bounds = quickWindow.getBounds();
    const x = Math.round(bounds.width / 2);
    const y = Math.round(bounds.height / 2);
    quickWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    quickWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  private clearFocusTimeouts(): void {
    this.focusTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.focusTimeouts = [];
  }

  private resizeWindow(payload: unknown): { success: boolean } {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null || quickWindow.isDestroyed()) {
      return { success: false };
    }

    const height =
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as QuickQueryResizePayload).height === 'number'
        ? (payload as QuickQueryResizePayload).height
        : LAUNCHER_WINDOW_HEIGHT;

    this.applyWindowHeight(quickWindow, height);
    return { success: true };
  }

  private applyWindowHeight(quickWindow: BrowserWindow, height: number): void {
    const clamped = Math.max(
      LAUNCHER_WINDOW_HEIGHT,
      Math.min(LAUNCHER_WINDOW_MAX_HEIGHT, Math.round(height))
    );
    quickWindow.setMinimumSize(LAUNCHER_WINDOW_WIDTH, LAUNCHER_WINDOW_HEIGHT);
    quickWindow.setMaximumSize(LAUNCHER_WINDOW_WIDTH, LAUNCHER_WINDOW_MAX_HEIGHT);
    quickWindow.setContentSize(LAUNCHER_WINDOW_WIDTH, clamped);
  }

  private getDevLauncherUrl(): string {
    const port = process.env.MAC_APP_PORT ?? '5174';
    return `http://localhost:${port}/launcher.html`;
  }
}
