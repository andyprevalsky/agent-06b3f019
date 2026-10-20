import { vi } from 'vitest';

/**
 * Darwin-only native addon. Vitest on Linux still imports messaging barrels that
 * transitively require it — stub at module scope so hoisting covers those graphs.
 */
vi.mock('node-mac-contacts', () => ({
  authorizationStatus: vi.fn(() => 'authorized'),
  getAllContacts: vi.fn(() => []),
  getContactsByName: vi.fn(() => []),
  requestAccess: vi.fn(async () => true),
}));

/**
 * Default stubs for Electron modules used by main-process domains.
 *
 * Main-process tests call these before importing the domain under test so the
 * domain's module-level `require('electron')` / `import 'electron-store'` calls
 * resolve to no-op stubs instead of real native bindings.
 *
 * Workers may override individual returns per-test with `vi.mocked(...).mockReturnValueOnce(...)`.
 */

/**
 * Build a fresh BrowserWindow-instance stub. Exported so tests that need to
 * re-install the BrowserWindow implementation mid-suite (e.g. via
 * `vi.mocked(BrowserWindow).mockImplementation(makeBrowserWindowStub)`) don't
 * have to re-declare the shape.
 */
export function makeBrowserWindowStub(): Record<string, unknown> {
  return {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      isLoading: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve()),
    },
    on: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    focusOnWebView: vi.fn(),
    moveTop: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1800, height: 800 })),
    getSize: vi.fn(() => [1800, 800]),
    getContentSize: vi.fn(() => [1800, 800]),
    setContentSize: vi.fn(),
    setMinimumSize: vi.fn(),
    setMaximumSize: vi.fn(),
    setPosition: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setWindowButtonVisibility: vi.fn(),
  };
}

export function stubElectron(): void {
  vi.mock('electron', () => ({
    app: {
      name: '',
      isPackaged: false,
      getPath: vi.fn(() => process.env.MAC_APP_TEST_USER_DATA ?? '/tmp/mac-app-test'),
      getAppPath: vi.fn(() => process.env.MAC_APP_TEST_APP_PATH ?? '/tmp/mac-app-test/app'),
      getName: vi.fn(() => 'rose-desktop-test'),
      getVersion: vi.fn(() => '0.0.0-test'),
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      disableHardwareAcceleration: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      isReady: vi.fn(() => true),
      requestSingleInstanceLock: vi.fn(() => true),
      setAsDefaultProtocolClient: vi.fn(() => true),
      focus: vi.fn(),
      dock: {
        show: vi.fn(),
        setIcon: vi.fn(),
      },
    },
    BrowserWindow: vi.fn().mockImplementation(function () {
      return makeBrowserWindowStub();
    }),
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((s: string) => Buffer.from(s)),
      decryptString: vi.fn((b: Buffer) => b.toString()),
    },
    shell: { openExternal: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showErrorBox: vi.fn() },
    Notification: vi.fn().mockImplementation(function () {
      return { show: vi.fn() };
    }),
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
    Tray: vi.fn(),
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn(),
      unregisterAll: vi.fn(),
      isRegistered: vi.fn(() => false),
    },
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getAllDisplays: vi.fn(() => []),
    },
  }));
}

export function stubElectronStore(): void {
  vi.mock('electron-store', () => ({
    // `function`, not an arrow: these are constructed with `new`, which vitest 4
    // rejects for arrow implementations.
    default: vi.fn().mockImplementation(function () {
      // Each Store instance gets its own backing Map so different stores in the
      // same test (e.g. onboardingStore + shortcutStore in the IPC registry)
      // don't share keys.
      const storage = new Map<string, unknown>();
      return {
        get: vi.fn((key: string, fallback?: unknown) =>
          storage.has(key) ? storage.get(key) : fallback
        ),
        set: vi.fn((key: string, value: unknown) => storage.set(key, value)),
        delete: vi.fn((key: string) => storage.delete(key)),
        clear: vi.fn(() => storage.clear()),
        has: vi.fn((key: string) => storage.has(key)),
      };
    }),
  }));
}

export function stubElectronUpdater(): void {
  vi.mock('electron-updater', () => ({
    autoUpdater: {
      checkForUpdatesAndNotify: vi.fn(() => Promise.resolve()),
      checkForUpdates: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      setFeedURL: vi.fn(),
    },
  }));
}

export function stubBetterSqlite3(): void {
  vi.mock('better-sqlite3', () => ({
    default: vi.fn().mockImplementation(function () {
      return {
        prepare: vi.fn(() => ({
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
          run: vi.fn(() => ({ changes: 0 })),
        })),
        exec: vi.fn(),
        close: vi.fn(),
        pragma: vi.fn(),
      };
    }),
  }));
}

export function stubAllElectron(): void {
  stubElectron();
  stubElectronStore();
  stubElectronUpdater();
  stubBetterSqlite3();
}
