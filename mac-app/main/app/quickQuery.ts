import { app, BrowserWindow, globalShortcut, ipcMain, type WebContents } from 'electron';
import path from 'path';
import { config } from '../base/config';
import { getPackagedRendererPath } from './packagedPaths';
import type {
  QuickQueryHeldSubmit,
  QuickQueryPayload,
  QuickQueryToggleState,
} from '../../shared/types/ipc';
import { HeldQuickQuerySubmits } from './quickQueryHeldSubmits';
import { normalizeQuickQueryPayload } from './quickQueryPayload';
import { scheduleQuickQueryFocusAttempts } from './quickQueryFocus';
import {
  LAUNCHER_WINDOW_HEIGHT,
  LAUNCHER_WINDOW_MAX_HEIGHT,
  LAUNCHER_WINDOW_WIDTH,
  applyQuickQueryWindowHeight,
  getDevLauncherUrl,
  parseFileDragActive,
  positionQuickQueryWindow,
  resizeQuickQueryWindow,
} from './quickQueryGeometry';

/**
 * Delay blur→hide so Finder/screenshot file-drags can re-enter the window.
 * Screenshot thumbnails often spawn in a screen corner; dragging from there to
 * the bottom-center launcher routinely takes multiple seconds. 500ms was too
 * short and hid the pill before dragover could cancel the hide.
 */
export const QUICK_QUERY_BLUR_HIDE_DELAY_MS = 5_000;

interface QuickQueryControllerOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Creates the main window when it was closed, then restores and focuses it. */
  openMainWindow: () => void;
  getOnboardingComplete: () => boolean;
}

export class QuickQueryController {
  private quickQueryWindow: BrowserWindow | null = null;
  private blurEnabled = false;
  private fileDragActive = false;
  private blurHideTimer: NodeJS.Timeout | null = null;
  private lastHiddenAt = 0;
  private shownAt = 0;
  private focusTimeouts: NodeJS.Timeout[] = [];
  private shortcutsEnabled = false;
  private readonly heldSubmits = new HeldQuickQuerySubmits();

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
      // Inactive window must still accept the first click/drag from Finder.
      acceptFirstMouse: true,
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
      const hasContent =
        queryPayload.query.trim().length > 0 || (queryPayload.attachments?.length ?? 0) > 0;
      if (!hasContent) {
        this.hideWindow({ focusMain: true });
        return { success: true };
      }

      this.hideWindow();
      this.holdForMainWindow(queryPayload);
      return { success: true };
    });

    ipcMain.handle('quick-query:take', (event) => this.listPendingSubmits(event.sender));

    ipcMain.handle('quick-query:claim', (event, id: unknown) => {
      return { claimed: this.claimPendingSubmit(event.sender, id) };
    });

    ipcMain.handle('quick-query:hide', () => {
      this.hideWindow({ focusMain: true });
      return { success: true };
    });

    ipcMain.handle('quick-query:resize', (_event, payload: unknown) => {
      return resizeQuickQueryWindow(this.quickQueryWindow, payload);
    });

    ipcMain.handle('quick-query:file-drag', (_event, payload: unknown) => {
      this.setFileDragActive(parseFileDragActive(payload));
      return { success: true };
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
      } else if (this.canShowWindow()) {
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

  /**
   * Rose keeps running on macOS after its main window is closed, so the
   * launcher can submit with no main window, or with one whose renderer is not
   * listening yet. The submit waits here until that window's consumer claims
   * it: the renderer lists what is held when it starts listening and each time
   * it is told one is waiting, and claims a submit only when it can act on it.
   * A renderer that reloads or closes before claiming therefore loses nothing.
   */
  private holdForMainWindow(payload: QuickQueryPayload): void {
    this.heldSubmits.add(payload);
    // The submit is already held. Failing the IPC here would re-enable the
    // launcher input, and a retry would queue the same query a second time.
    try {
      this.options.openMainWindow();

      const mainWindow = this.options.getMainWindow();
      const mainWindowOpen = mainWindow !== null && !mainWindow.isDestroyed();
      console.log('[QuickQuery] Submit held for main window', {
        queryLength: payload.query.length,
        attachments: payload.attachments?.length ?? 0,
        pending: this.heldSubmits.size,
        mainWindowOpen,
      });
      if (mainWindowOpen) {
        mainWindow.webContents.send('quick-query:pending');
      }
    } catch (error) {
      console.error('[QuickQuery] Could not open the main window; submit stays held', error);
    }
  }

  private isMainWindowSender(sender: WebContents): boolean {
    const mainWindow = this.options.getMainWindow();
    return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents === sender;
  }

  private listPendingSubmits(sender: WebContents): QuickQueryHeldSubmit[] {
    return this.isMainWindowSender(sender) ? this.heldSubmits.list() : [];
  }

  private claimPendingSubmit(sender: WebContents, id: unknown): boolean {
    if (!this.isMainWindowSender(sender) || !this.heldSubmits.claim(id)) return false;

    console.log('[QuickQuery] Submit claimed by main window', { pending: this.heldSubmits.size });
    return true;
  }

  private configureWindow(quickWindow: BrowserWindow): void {
    applyQuickQueryWindowHeight(quickWindow, LAUNCHER_WINDOW_HEIGHT);
    quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    quickWindow.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      quickWindow.setWindowButtonVisibility(false);
    }

    if (config.isDev) {
      void quickWindow.loadURL(getDevLauncherUrl());
    } else {
      void quickWindow.loadFile(getPackagedRendererPath('launcher.html'));
    }

    quickWindow.webContents.once('did-finish-load', () => {
      console.log('[QuickQuery] Window size:', quickWindow.getSize());
      console.log('[QuickQuery] Content size:', quickWindow.getContentSize());
      console.log('[QuickQuery] Bounds:', quickWindow.getBounds());
    });

    // Dropping a file onto Electron navigates the webContents by default.
    quickWindow.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    quickWindow.on('blur', () => {
      if (!this.blurEnabled) return;
      // Starting a Finder/screenshot drag steals focus. Defer hide so the
      // drag can re-enter; renderer cancels via quick-query:file-drag.
      this.scheduleBlurHide();
    });

    quickWindow.on('focus', () => {
      this.cancelBlurHide();
    });
    quickWindow.on('closed', () => {
      this.quickQueryWindow = null;
    });
  }

  private setFileDragActive(active: boolean): void {
    this.fileDragActive = active;
    if (!active) return;

    this.cancelBlurHide();
    // Stop focus steals mid-drag — synthetic center-clicks can hit the
    // paperclip and open Finder while the screenshot thumbnail is in flight.
    this.clearFocusTimeouts();
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null || quickWindow.isDestroyed()) return;

    // Blur-hide may have already won the race — bring the pill back under
    // the cursor without stealing focus from the drag source.
    if (!quickWindow.isVisible()) {
      quickWindow.showInactive();
      this.blurEnabled = true;
      console.log('[QuickQuery] Re-shown inactive for in-flight file drag');
    }
  }

  private scheduleBlurHide(): void {
    this.cancelBlurHide();
    this.blurHideTimer = setTimeout(() => {
      this.blurHideTimer = null;
      if (!this.blurEnabled || this.fileDragActive) return;
      this.hideWindow();
    }, QUICK_QUERY_BLUR_HIDE_DELAY_MS);
  }

  private cancelBlurHide(): void {
    if (this.blurHideTimer === null) return;
    clearTimeout(this.blurHideTimer);
    this.blurHideTimer = null;
  }

  private canShowWindow(): boolean {
    if (this.quickQueryWindow === null) return false;

    if (this.options.getOnboardingComplete() !== true) {
      console.log('[QuickQuery] Blocked show - onboarding not complete');
      return false;
    }

    return Date.now() - this.lastHiddenAt >= 2000;
  }

  private showWindow(): void {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null || !this.canShowWindow()) return;

    this.cancelBlurHide();
    this.fileDragActive = false;
    this.blurEnabled = false;
    this.shownAt = Date.now();
    applyQuickQueryWindowHeight(quickWindow, LAUNCHER_WINDOW_HEIGHT);
    positionQuickQueryWindow(quickWindow);
    app.focus({ steal: true });
    quickWindow.show();
    quickWindow.focus();
    quickWindow.focusOnWebView();
    this.clearFocusTimeouts();
    scheduleQuickQueryFocusAttempts(quickWindow, this.focusTimeouts);
    this.emitToggle({ open: true });

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

    this.cancelBlurHide();
    this.clearFocusTimeouts();
    this.blurEnabled = false;
    this.fileDragActive = false;
    this.lastHiddenAt = Date.now();
    if (!quickWindow.isDestroyed()) {
      quickWindow.hide();
      this.emitToggle({ open: false });
    }

    const mainWindow = this.options.getMainWindow();
    if (focusMain === true && mainWindow !== null) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  private emitToggle(state: QuickQueryToggleState): void {
    const quickWindow = this.quickQueryWindow;
    if (quickWindow === null || quickWindow.isDestroyed()) return;
    const send = () => quickWindow.webContents.send('quick-query:toggle', state);

    if (quickWindow.webContents.isLoading()) {
      quickWindow.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  }

  private clearFocusTimeouts(): void {
    this.focusTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.focusTimeouts = [];
  }
}
