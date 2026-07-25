/**
 * Blackbox test for the compiled Electron startup path.
 *
 * The regular Vitest suite imports TypeScript source through Vite. This test
 * exercises the path Electron actually runs: tsc emits CommonJS files, the
 * compiled main entry creates BrowserWindows, and the compiled preload file
 * installs window.api before renderer code can call it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const STARTUP_MARKER = '@@ROSE_COMPILED_STARTUP@@';

interface StartupProbe {
  windowCount: number;
  preloadPath: string;
  loadUrlPaths: string[];
  loadFilePaths: string[];
  sandboxValues: Array<boolean | null>;
  exposedKey: string | null;
  hasApi: boolean;
  hasUpdateStatus: boolean;
  hasQuickQuerySubmit: boolean;
  ipcHandleCount: number;
}

interface StartupProbeOptions {
  appPath?: string;
  isPackaged?: boolean;
}

function compileMain(outDir: string): void {
  execFileSync(
    process.execPath,
    [TSC_BIN, '-p', path.join(ROOT, 'tsconfig.main.json'), '--outDir', outDir, '--pretty', 'false'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        VITE_SUPABASE_URL: 'https://test.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      },
      encoding: 'utf8',
    }
  );
}

function buildStartupProbe(mainEntry: string, options: StartupProbeOptions = {}): string {
  return `
const Module = require('node:module');
const path = require('node:path');

process.stdin.resume = function noopResume() {};
process.stdin.on = function noopOn() { return process.stdin; };

const mainEntry = ${JSON.stringify(mainEntry)};
const marker = ${JSON.stringify(STARTUP_MARKER)};
const appPath = ${JSON.stringify(options.appPath ?? path.dirname(path.dirname(mainEntry)))};
const isPackaged = ${JSON.stringify(options.isPackaged ?? false)};
const rootRequire = Module.createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});
if (isPackaged) {
  process.resourcesPath = path.join(appPath, 'Contents', 'Resources');
}
const windows = [];
const ipcHandles = [];
const loadUrlPaths = [];
const loadFilePaths = [];
let exposed = null;

function makeWebContents() {
  return {
    send() {},
    on() {},
    once() {},
    isLoading() { return false; },
    setWindowOpenHandler() {},
    openDevTools() {},
    focus() {},
    sendInputEvent() {},
    executeJavaScript() { return Promise.resolve(); },
  };
}

function BrowserWindow(options) {
  const win = {
    options,
    webContents: makeWebContents(),
    on() {},
    show() {},
    hide() {},
    close() {},
    focus() {},
    focusOnWebView() {},
    moveTop() {},
    isDestroyed() { return false; },
    isVisible() { return false; },
    isMaximized() { return false; },
    maximize() {},
    getBounds() { return { x: 0, y: 0, width: 1800, height: 800 }; },
    getSize() { return [1800, 800]; },
    getContentSize() { return [1800, 800]; },
    setContentSize() {},
    setPosition() {},
    setVisibleOnAllWorkspaces() {},
    setAlwaysOnTop() {},
    setWindowButtonVisibility() {},
    loadURL(url) {
      loadUrlPaths.push(url);
      return Promise.resolve();
    },
    loadFile(filePath) {
      loadFilePaths.push(filePath);
      return Promise.resolve();
    },
  };
  windows.push(win);
  return win;
}

BrowserWindow.fromWebContents = function fromWebContents() {
  return windows[0] || null;
};

class Store {
  constructor(options) {
    this.storage = new Map(Object.entries((options && options.defaults) || {}));
  }
  get(key, fallback) {
    return this.storage.has(key) ? this.storage.get(key) : fallback;
  }
  set(key, value) {
    this.storage.set(key, value);
  }
  delete(key) {
    this.storage.delete(key);
  }
  clear() {
    this.storage.clear();
  }
  has(key) {
    return this.storage.has(key);
  }
}

function BetterSqlite3() {
  return {
    prepare() {
      return {
        all() { return []; },
        get() { return undefined; },
        run() { return { changes: 0 }; },
      };
    },
    exec() {},
    close() {},
    pragma() {},
  };
}

class ClassicLevel {
  constructor() {
    this.storage = new Map();
  }
  get(key) {
    if (this.storage.has(key)) return Promise.resolve(this.storage.get(key));
    const error = new Error('Not found');
    error.code = 'LEVEL_NOT_FOUND';
    return Promise.reject(error);
  }
  put(key, value) {
    this.storage.set(key, value);
    return Promise.resolve();
  }
  del(key) {
    this.storage.delete(key);
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const electronStub = {
  app: {
    name: '',
    isPackaged,
    getPath() { return '/tmp/mac-app-compiled-startup'; },
    getAppPath() { return appPath; },
    getName() { return 'rose-desktop-test'; },
    getVersion() { return '0.0.0-test'; },
    requestSingleInstanceLock() { return true; },
    on() {},
    whenReady() { return Promise.resolve(); },
    quit() {},
    isReady() { return true; },
    setAsDefaultProtocolClient() { return true; },
    focus() {},
    dock: {
      show() {},
      setIcon() {},
    },
  },
  BrowserWindow,
  ipcMain: {
    handle(channel) { ipcHandles.push(channel); },
    on() {},
    removeHandler() {},
  },
  ipcRenderer: {
    invoke() { return Promise.resolve(); },
    send() {},
    on() {},
    removeAllListeners() {},
    removeListener() {},
  },
  contextBridge: {
    exposeInMainWorld(key, api) {
      exposed = { key, api };
    },
  },
  safeStorage: {
    isEncryptionAvailable() { return true; },
    encryptString(value) { return Buffer.from(value); },
    decryptString(value) { return Buffer.from(value).toString(); },
  },
  shell: { openExternal() { return Promise.resolve(); } },
  dialog: { showMessageBox() { return Promise.resolve(); }, showErrorBox() {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
  Tray: function Tray() {},
  nativeImage: { createFromPath() { return {}; } },
  globalShortcut: {
    register() { return true; },
    unregister() {},
    unregisterAll() {},
    isRegistered() { return false; },
  },
  screen: {
    getCursorScreenPoint() { return { x: 0, y: 0 }; },
    getDisplayNearestPoint() {
      return { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    },
    getPrimaryDisplay() {
      return { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    },
    getAllDisplays() { return []; },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-store') return { __esModule: true, default: Store };
  if (request === 'electron-updater') {
    return {
      autoUpdater: {
        checkForUpdatesAndNotify() { return Promise.resolve(); },
        checkForUpdates() { return Promise.resolve(); },
        on() {},
        setFeedURL() {},
      },
    };
  }
  if (request === 'better-sqlite3') return BetterSqlite3;
  if (request === 'classic-level') return { ClassicLevel };
  if (request === 'node-mac-contacts') {
    return {
      authorizationStatus() { return 'authorized'; },
      getAllContacts() { return []; },
    };
  }
  try {
    return originalLoad.apply(this, arguments);
  } catch (error) {
    if (!request.startsWith('.') && !path.isAbsolute(request)) {
      return rootRequire(request);
    }
    throw error;
  }
};

require(mainEntry);

function finish() {
  try {
    const mainWindow = windows[0];
    if (!mainWindow) throw new Error('Compiled main entry did not create BrowserWindow');

    const preloadPath = mainWindow.options && mainWindow.options.webPreferences && mainWindow.options.webPreferences.preload;
    if (typeof preloadPath !== 'string' || preloadPath.length === 0) {
      throw new Error('Compiled main BrowserWindow has no preload path');
    }

    require(preloadPath);
    const api = exposed && exposed.api;
    const sandboxValues = windows.map((win) => {
      const preferences = win.options && win.options.webPreferences;
      return preferences && typeof preferences.sandbox === 'boolean' ? preferences.sandbox : null;
    });

    console.log(marker + JSON.stringify({
      windowCount: windows.length,
      preloadPath,
      loadUrlPaths,
      loadFilePaths,
      sandboxValues,
      exposedKey: exposed && exposed.key,
      hasApi: Boolean(api),
      hasUpdateStatus: Boolean(api && typeof api.onUpdateStatus === 'function'),
      hasQuickQuerySubmit: Boolean(api && typeof api.onQuickQuerySubmit === 'function'),
      ipcHandleCount: ipcHandles.length,
    }));
    process.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

setImmediate(() => setImmediate(finish));
`;
}

function runStartupProbe(mainEntry: string, options: StartupProbeOptions = {}): StartupProbe {
  const output = execFileSync(process.execPath, ['-e', buildStartupProbe(mainEntry, options)], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_BACKEND_API_URL: 'http://localhost:3001',
      MAC_APP_PORT: '59999',
    },
    encoding: 'utf8',
  });
  const markerLine = output.split('\n').find((line) => line.startsWith(STARTUP_MARKER));
  if (markerLine === undefined) {
    throw new Error(`Compiled startup probe did not emit marker. Output:\n${output}`);
  }
  return JSON.parse(markerLine.slice(STARTUP_MARKER.length)) as StartupProbe;
}

describe('compiled Electron startup blackbox', () => {
  it('keeps credential-provider entitlement off inherited Electron helper entitlements', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      build: {
        mac: {
          entitlements: string;
          entitlementsInherit: string;
        };
      };
    };

    expect(packageJson.build.mac.entitlements).toBe('entitlements.mac.plist');
    expect(packageJson.build.mac.entitlementsInherit).toBe('entitlements.inherit.mac.plist');

    const appEntitlements = plist.parse(
      fs.readFileSync(path.join(ROOT, packageJson.build.mac.entitlements), 'utf8')
    ) as Record<string, unknown>;
    const inheritedEntitlements = plist.parse(
      fs.readFileSync(path.join(ROOT, packageJson.build.mac.entitlementsInherit), 'utf8')
    ) as Record<string, unknown>;

    expect(
      appEntitlements['com.apple.developer.authentication-services.autofill-credential-provider']
    ).toBe(true);
    expect(appEntitlements['com.apple.application-identifier']).toBe('P3HATASMP9.com.rose.desktop');
    expect(appEntitlements['com.apple.developer.team-identifier']).toBe('P3HATASMP9');
    expect(appEntitlements['keychain-access-groups']).toEqual(['P3HATASMP9.*']);
    expect(
      inheritedEntitlements[
        'com.apple.developer.authentication-services.autofill-credential-provider'
      ]
    ).toBeUndefined();
    expect(inheritedEntitlements['com.apple.security.cs.allow-jit']).toBe(true);
    expect(inheritedEntitlements['com.apple.security.cs.allow-unsigned-executable-memory']).toBe(
      true
    );
    expect(inheritedEntitlements['com.apple.security.cs.disable-library-validation']).toBe(true);
  });

  it('signs the credential-provider extension with the app identifier from its profile', () => {
    const providerEntitlements = plist.parse(
      fs.readFileSync(
        path.join(ROOT, 'native', 'passkey-provider', 'provider.entitlements'),
        'utf8'
      )
    ) as Record<string, unknown>;

    expect(
      providerEntitlements[
        'com.apple.developer.authentication-services.autofill-credential-provider'
      ]
    ).toBe(true);
    expect(providerEntitlements['com.apple.application-identifier']).toBe(
      'P3HATASMP9.com.rose.desktop.PasskeyProvider'
    );
    expect(providerEntitlements['com.apple.developer.team-identifier']).toBe('P3HATASMP9');
    expect(providerEntitlements['keychain-access-groups']).toEqual(['P3HATASMP9.*']);
  });

  it('does not bundle any Python helper — IndexedDB is read natively in TS', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      build: {
        extraResources: Array<{ from: string; to: string }>;
      };
    };

    // The Chrome IndexedDB reader is now pure TypeScript (see
    // main/domains/indexed-db-reader/native/), so nothing python-related should
    // ship in the bundle. Guarding this prevents a regression back to the
    // spawn('python3') path that triggered the macOS CLT installer stub.
    for (const resource of packageJson.build.extraResources) {
      expect(resource.from.endsWith('.py')).toBe(false);
    }
  });

  it('compiles main/preload output and starts with window.api installed', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-compiled-startup-'));
    try {
      compileMain(outDir);

      const preloadPath = path.join(outDir, 'main', 'preload.js');
      const preloadRuntimePath = path.join(
        outDir,
        'main',
        'domains',
        'electron-preload',
        'runtime.js'
      );
      expect(fs.existsSync(path.join(outDir, 'main', 'index.js'))).toBe(true);
      expect(fs.existsSync(preloadPath)).toBe(true);
      expect(fs.existsSync(preloadRuntimePath)).toBe(true);

      const probe = runStartupProbe(path.join(outDir, 'main', 'index.js'));
      expect(probe.windowCount).toBeGreaterThanOrEqual(2);
      expect(probe.loadFilePaths).toEqual([]);
      expect(fs.realpathSync(probe.preloadPath)).toBe(fs.realpathSync(preloadPath));
      expect(probe.sandboxValues.every((value) => value === false)).toBe(true);
      expect(probe.exposedKey).toBe('api');
      expect(probe.hasApi).toBe(true);
      expect(probe.hasUpdateStatus).toBe(true);
      expect(probe.hasQuickQuerySubmit).toBe(true);
      expect(probe.ipcHandleCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('loads packaged renderer files from the app root dist/ui directory', () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-packaged-startup-'));
    try {
      const mainOutDir = path.join(packageRoot, 'dist', 'main');
      const uiDir = path.join(packageRoot, 'dist', 'ui');
      fs.mkdirSync(uiDir, { recursive: true });
      fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><div id="root"></div>');
      fs.writeFileSync(path.join(uiDir, 'launcher.html'), '<!doctype html><div id="root"></div>');

      compileMain(mainOutDir);

      const probe = runStartupProbe(path.join(mainOutDir, 'main', 'index.js'), {
        appPath: packageRoot,
        isPackaged: true,
      });

      expect(probe.loadFilePaths).toContain(path.join(packageRoot, 'dist', 'ui', 'index.html'));
      expect(probe.loadFilePaths).toContain(path.join(packageRoot, 'dist', 'ui', 'launcher.html'));
      expect(probe.loadFilePaths.every((filePath) => fs.existsSync(filePath))).toBe(true);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
