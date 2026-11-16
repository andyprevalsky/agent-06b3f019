/**
 * Blackbox tests for the `electron-main` domain (Electron main-process app wiring).
 *
 * Entry: main/index.ts
 * Type:  main-wiring
 *
 * Observable surface we exercise:
 *   - Module-load side effects:
 *       * `app.name` is set to 'Rose'
 *       * a deep-link protocol is registered via `app.setAsDefaultProtocolClient`
 *       * lifecycle listeners are attached to `app` (open-url, window-all-closed,
 *         activate, will-quit) and to `process.stdin` ('close')
 *       * a window-state `electron-store` is constructed with name 'window-state'
 *   - `app.whenReady` callback:
 *       * creates the main BrowserWindow + quick-query BrowserWindow
 *       * registers IPC handlers for quick-query:*, shortcut:*, and the
 *         auto-updater IPC surface
 *       * initialises the auto-updater against the main window
 *   - Deep-link handler: roselabs://payment-success and roselabs://payment-cancel
 *     forward `payment-complete` to the main window's webContents
 *   - Onboarding gate: when onboarding is incomplete, global shortcuts are NOT
 *     registered at whenReady time
 *
 * Scope deferrals (documented in the PR body, not tested here):
 *   flake×5, concurrent-invocation, negative-control, broader-suite
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeBrowserWindowStub,
  stubElectron,
  stubElectronStore,
  stubElectronUpdater,
} from './electron-stubs';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Electron + native-module stubs (installed once, shared across tests) ────
// vi.mock is hoisted, so the factories registered here apply for the lifetime
// of this test file. Subsequent resetModules() calls re-run the factories
// automatically — we do NOT need to re-invoke stubXxx() per test.
stubElectron();
stubElectronStore();
stubElectronUpdater();

// ── Stub domain-internal heavy imports so we test *wiring*, not deps ────────
let onboardingCompleteFlag = true;
let configIsDev = false;

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'http://localhost:3001',
    supabase: { url: 'https://test.supabase.co', anonKey: 'test-anon-key' },
    encryptionKey: 'test-key',
    get isDev() {
      return configIsDev;
    },
  },
}));

vi.mock('../../main/handlers/registry', () => ({
  registerHandlers: vi.fn(),
  getShortcutConfig: vi.fn(() => null),
  getOnboardingComplete: vi.fn(() => onboardingCompleteFlag),
}));

vi.mock('../../main/domains/i-message-reader/runtime', () => ({
  IMessageReader: { checkAccess: vi.fn(() => ({ hasAccess: true })) },
}));

const initAutoUpdaterMock = vi.fn();
const setAutoUpdaterWindowMock = vi.fn();
const manualCheckForUpdatesMock = vi.fn();
const restartToUpdateMock = vi.fn();
const isUpdateDownloadedMock = vi.fn(() => false);
const registerUpdateIpcMock = vi.fn();
const getSessionMock = vi.fn(() => Promise.resolve({ access_token: 'test-access-token' }));
const importPasskeysFromTokenMock = vi.fn(() =>
  Promise.resolve({ success: true, count: 1, passkeyCount: 1, passwordCount: 0 })
);

vi.mock('../../main/domains/auto-updater/runtime', () => ({
  initAutoUpdater: initAutoUpdaterMock,
  setAutoUpdaterWindow: setAutoUpdaterWindowMock,
  manualCheckForUpdates: manualCheckForUpdatesMock,
  restartToUpdate: restartToUpdateMock,
  isUpdateDownloaded: isUpdateDownloadedMock,
  registerUpdateIpc: registerUpdateIpcMock,
}));

vi.mock('../../main/domains/local-code-runner/runtime', () => ({
  startLocalCodeRunner: vi.fn(),
}));
// The real runtime writes ~/.rose/bin/rose; wiring tests must never touch the user's home.
const startRoseCliMock = vi.fn();
vi.mock('../../main/domains/rose-cli/runtime', () => ({
  startRoseCli: startRoseCliMock,
}));
vi.mock('../../main/domains/auth/runtime', () => ({
  AuthService: { getSession: getSessionMock },
}));

vi.mock('../../main/domains/passkey-import/service', () => ({
  importPasskeysFromToken: importPasskeysFromTokenMock,
}));

// ── Test helpers ────────────────────────────────────────────────────────────

interface Handle<Listener = (...args: unknown[]) => unknown> {
  event: string;
  listener: Listener;
}

/** Pull registered listeners off the `app` mock for a given event name. */
async function appListenersFor(event: string): Promise<Handle[]> {
  const electron = await import('electron');
  const mockOn = vi.mocked(electron.app.on);
  return mockOn.mock.calls
    .filter((c) => c[0] === event)
    .map((c) => ({ event: c[0] as string, listener: c[1] as Handle['listener'] }));
}

/** Pull registered ipcMain.handle channel names. */
async function ipcHandleChannels(): Promise<string[]> {
  const electron = await import('electron');
  const mockHandle = vi.mocked(electron.ipcMain.handle);
  return mockHandle.mock.calls.map((c) => c[0] as string);
}

/** Pull one registered quick-query ipcMain handler. */
async function quickQueryHandler(
  channel: 'quick-query:submit' | 'quick-query:take' | 'quick-query:claim'
): Promise<(event: unknown, payload?: unknown) => unknown> {
  const electron = await import('electron');
  const handler = vi
    .mocked(electron.ipcMain.handle)
    .mock.calls.find(([registered]) => registered === channel)?.[1];
  expect(handler).toBeDefined();
  return handler as unknown as (event: unknown, payload?: unknown) => unknown;
}

let currentWhenReadyResolver: (() => void) | null = null;

/**
 * Resolve the deferred whenReady promise and flush microtasks so every
 * `.then()` callback attached to `app.whenReady()` has run. The default
 * `loadMainEntry` installs an unresolved whenReady — tests that want the
 * whenReady block to execute call this helper explicitly.
 */
async function flushWhenReady(): Promise<void> {
  if (!currentWhenReadyResolver) return;
  currentWhenReadyResolver();
  currentWhenReadyResolver = null;
  // Two ticks: first drains the .then on whenReady, second drains any
  // follow-on microtasks scheduled by that callback.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/**
 * Reload main/index.ts in a clean module registry.
 *
 * `vi.resetModules()` rebuilds the electron mock from its factory, but vitest
 * memoises the factory result, so the same `vi.fn()` identities persist
 * across tests. We therefore clear + re-implement every spy we assert on and
 * install a *deferred* whenReady (resolved on demand via flushWhenReady) to
 * prevent async .then callbacks from leaking into later tests.
 *
 * Callers that need to override additional behaviour (e.g. make BrowserWindow
 * throw) pass a `configure` callback — it runs after the reset but before
 * main/index.ts evaluates, so overrides hit the same electron instance that
 * main/index sees.
 */
async function loadMainEntry(
  configure?: (electron: typeof import('electron')) => void | Promise<void>
): Promise<void> {
  vi.resetModules();

  const electron = await import('electron');

  vi.mocked(electron.app.on).mockReset();
  vi.mocked(electron.app.setAsDefaultProtocolClient).mockClear();
  vi.mocked(electron.app.setAsDefaultProtocolClient).mockImplementation(() => true);
  vi.mocked(electron.app.requestSingleInstanceLock).mockClear();
  vi.mocked(electron.app.requestSingleInstanceLock).mockImplementation(() => true);
  vi.mocked(electron.app.quit).mockClear();
  vi.mocked(electron.app.exit).mockClear();
  vi.mocked(electron.ipcMain.handle).mockClear();
  vi.mocked(electron.app.whenReady).mockClear();
  vi.mocked(electron.BrowserWindow).mockClear();
  vi.mocked(electron.BrowserWindow).mockImplementation(
    () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
  );
  vi.mocked(electron.globalShortcut.register).mockClear();
  vi.mocked(electron.globalShortcut.register).mockImplementation(() => true);
  vi.mocked(electron.globalShortcut.unregisterAll).mockClear();

  // Install a deferred whenReady. The configurator (if any) may override it.
  const deferred = new Promise<void>((resolve) => {
    currentWhenReadyResolver = resolve;
  });
  vi.mocked(electron.app.whenReady).mockImplementation(() => deferred);

  if (configure) {
    await configure(electron);
  }
  await import('../../main/index');
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('blackbox: electron-main (main-wiring)', () => {
  let originalStdinResume: typeof process.stdin.resume;
  let originalStdinOn: typeof process.stdin.on;
  let stdinOnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    onboardingCompleteFlag = true;
    configIsDev = false;
    delete process.env.OPEN_DEVTOOLS;
    initAutoUpdaterMock.mockClear();
    setAutoUpdaterWindowMock.mockClear();
    registerUpdateIpcMock.mockClear();
    getSessionMock.mockClear();
    getSessionMock.mockResolvedValue({ access_token: 'test-access-token' });
    startRoseCliMock.mockClear();
    importPasskeysFromTokenMock.mockClear();
    importPasskeysFromTokenMock.mockResolvedValue({
      success: true,
      count: 1,
      passkeyCount: 1,
      passwordCount: 0,
    });
    clearFetchCaptures();

    // Neutralise process.stdin side effects so the test runner is not affected.
    originalStdinResume = process.stdin.resume.bind(process.stdin);
    originalStdinOn = process.stdin.on.bind(process.stdin);
    process.stdin.resume = vi.fn() as unknown as typeof process.stdin.resume;
    stdinOnMock = vi.fn(() => process.stdin) as unknown as ReturnType<typeof vi.fn>;
    process.stdin.on = stdinOnMock as unknown as typeof process.stdin.on;

    // Drop any prior whenReady resolver — loadMainEntry installs a fresh
    // deferred whenReady each call. vi.resetModules() inside loadMainEntry
    // also rebuilds the electron mock factory, giving each test fresh
    // spy state (app.on, ipcMain.handle, BrowserWindow, etc.).
    currentWhenReadyResolver = null;
    // Default platform/packaging assumptions for module-load code paths.
    // Node.js `process.platform` is read-only in types but writable at runtime in tests.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    process.stdin.resume = originalStdinResume;
    process.stdin.on = originalStdinOn;
    // Do NOT call vi.restoreAllMocks() — it strips inner vi.fn()s from module
    // mocks (e.g. electron-store's Store().get/set), breaking subsequent tests.
  });

  // ── Happy path: module-load wiring ────────────────────────────────────────

  it('module-load: sets app.name, registers deep-link protocol, attaches lifecycle listeners', async () => {
    await loadMainEntry();

    const electron = await import('electron');
    expect(electron.app.name).toBe('Rose');
    expect(vi.mocked(electron.app.disableHardwareAcceleration)).not.toHaveBeenCalled();

    // Exactly one protocol registration for the production scheme (isDev=false stub).
    const protoCalls = vi.mocked(electron.app.setAsDefaultProtocolClient).mock.calls;
    expect(protoCalls.length).toBeGreaterThanOrEqual(1);
    const registeredSchemes = protoCalls.map((c) => c[0]);
    expect(registeredSchemes).toContain('roselabs');

    expect(electron.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);

    const lifecycleEvents = [
      'open-url',
      'window-all-closed',
      'activate',
      'second-instance',
      'will-quit',
    ];
    for (const ev of lifecycleEvents) {
      const listeners = await appListenersFor(ev);
      expect(listeners.length, `expected a listener for app '${ev}'`).toBeGreaterThanOrEqual(1);
    }

    // stdin 'close' parent-death handling is dev-only; production must not
    // exit when launched by Finder/LaunchServices without an attached stdin.
    const closeCalls = stdinOnMock.mock.calls.filter((c) => c[0] === 'close');
    expect(closeCalls.length).toBe(0);
  }, 30_000);

  it('single-instance: duplicate launch requests quit instead of creating another importer', async () => {
    await loadMainEntry((electron) => {
      vi.mocked(electron.app.requestSingleInstanceLock).mockReturnValue(false);
    });

    const electron = await import('electron');
    expect(electron.app.quit).toHaveBeenCalled();
    expect(electron.app.exit).toHaveBeenCalledWith(0);

    const continueActivityListeners = await appListenersFor('continue-activity');
    expect(continueActivityListeners.length).toBe(0);
  });

  it('single-instance: dev mode skips the global lock so parallel workspaces can run', async () => {
    configIsDev = true;
    await loadMainEntry((electron) => {
      vi.mocked(electron.app.requestSingleInstanceLock).mockReturnValue(false);
    });

    const electron = await import('electron');
    expect(electron.app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(electron.app.exit).not.toHaveBeenCalled();

    const continueActivityListeners = await appListenersFor('continue-activity');
    expect(continueActivityListeners.length).toBeGreaterThanOrEqual(1);
  });

  it('dev window: keeps DevTools closed unless explicitly requested', async () => {
    configIsDev = true;
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const mainWindow = vi.mocked(electron.BrowserWindow).mock.results[0]?.value as {
      webContents: { openDevTools: ReturnType<typeof vi.fn> };
    };

    expect(mainWindow.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('dev window: opens DevTools when OPEN_DEVTOOLS=1', async () => {
    configIsDev = true;
    process.env.OPEN_DEVTOOLS = '1';
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const mainWindow = vi.mocked(electron.BrowserWindow).mock.results[0]?.value as {
      webContents: { openDevTools: ReturnType<typeof vi.fn> };
    };

    expect(mainWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it('module-load: constructs a window-state electron-store with name "window-state"', async () => {
    const Store = (await import('electron-store')).default;
    const StoreMock = vi.mocked(Store);
    StoreMock.mockClear();

    await loadMainEntry();

    // At least one Store built with name 'window-state'
    const names = StoreMock.mock.calls.map((c) => (c[0] as { name?: string } | undefined)?.name);
    expect(names).toContain('window-state');
  });

  // ── Happy path: whenReady creates windows + registers IPC + updater ───────

  it('whenReady: creates main + quick-query BrowserWindows and registers IPC surface', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    // Main window + quick-query window = 2 BrowserWindow constructions.
    expect(BrowserWindow.mock.calls.length).toBe(2);

    const channels = await ipcHandleChannels();
    for (const ch of [
      'quick-query:submit',
      'quick-query:take',
      'quick-query:claim',
      'quick-query:hide',
      'quick-query:resize',
      'quick-query:file-drag',
      'shortcut:enable',
      'shortcut:disable',
      'shortcut:isEnabled',
    ]) {
      expect(channels, `ipcMain.handle should register '${ch}'`).toContain(ch);
    }

    const quickQueryOptions = BrowserWindow.mock.calls[1]?.[0] as {
      acceptFirstMouse?: boolean;
      transparent?: boolean;
    };
    expect(quickQueryOptions.acceptFirstMouse).toBe(true);
    expect(quickQueryOptions.transparent).toBe(true);

    expect(registerUpdateIpcMock).toHaveBeenCalledTimes(1);
    expect(initAutoUpdaterMock).toHaveBeenCalledTimes(1);
    // Every start (re)writes the `rose` launcher for this app location.
    expect(startRoseCliMock).toHaveBeenCalledTimes(1);
  });

  it('whenReady: resets stale offscreen saved main-window placement to the primary display', async () => {
    const staleWindowState = {
      x: -376,
      y: -1410,
      width: 2560,
      height: 1410,
      isMaximized: true,
    };

    await loadMainEntry(async (electron) => {
      const Store = (await import('electron-store')).default;
      vi.mocked(Store).mockImplementation(
        () =>
          ({
            get: vi.fn((key: string, fallback?: unknown) =>
              key === 'mainWindow' ? staleWindowState : fallback
            ),
            set: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
            has: vi.fn(() => false),
          }) as never
      );
      vi.mocked(electron.screen.getPrimaryDisplay).mockReturnValue({
        workArea: { x: 0, y: 38, width: 1728, height: 1079 },
        bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      } as Electron.Display);
      vi.mocked(electron.screen.getAllDisplays).mockReturnValue([
        {
          workArea: { x: 0, y: 38, width: 1728, height: 1079 },
          bounds: { x: 0, y: 0, width: 1728, height: 1117 },
        },
        {
          workArea: { x: -376, y: -1410, width: 2560, height: 1410 },
          bounds: { x: -376, y: -1410, width: 2560, height: 1410 },
        },
      ] as Electron.Display[]);
    });
    await flushWhenReady();

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const mainWindowOptions = BrowserWindow.mock
      .calls[0][0] as Electron.BrowserWindowConstructorOptions;
    const mainWindow = BrowserWindow.mock.results[0]?.value as {
      maximize: ReturnType<typeof vi.fn>;
    };

    expect(mainWindowOptions).toMatchObject({
      x: 0,
      y: 38,
      width: 1728,
      height: 1079,
    });
    expect(mainWindow.maximize).not.toHaveBeenCalled();
  });

  it('whenReady: registers global shortcuts when onboarding is complete', async () => {
    onboardingCompleteFlag = true;
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const registered = vi.mocked(electron.globalShortcut.register).mock.calls.map((c) => c[0]);
    // Both primary and fallback shortcut are attempted.
    expect(registered).toContain('Alt+Space');
    expect(registered).toContain('Alt+Shift+Space');
  });

  it('activate before ready: waits for app readiness before creating screen-backed windows', async () => {
    await loadMainEntry((electron) => {
      vi.mocked(electron.app.isReady).mockReturnValue(false);
    });

    const activateListeners = await appListenersFor('activate');
    expect(activateListeners.length).toBeGreaterThanOrEqual(1);

    const electron = await import('electron');
    activateListeners[0].listener();

    expect(vi.mocked(electron.BrowserWindow)).not.toHaveBeenCalled();

    vi.mocked(electron.app.isReady).mockReturnValue(true);
    await flushWhenReady();

    expect(vi.mocked(electron.BrowserWindow).mock.calls.length).toBe(2);
  });

  // ── Empty state: first launch (onboarding not complete) ──────────────────

  it('first-launch (onboarding=false): does NOT register global shortcuts at whenReady', async () => {
    onboardingCompleteFlag = false;
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    // globalShortcut.register must NOT have been called for the launcher hotkeys.
    expect(vi.mocked(electron.globalShortcut.register).mock.calls.length).toBe(0);
  });

  // ── Deep link handling ────────────────────────────────────────────────────

  it('deep-link: payment-success forwards to main window webContents.send("payment-complete", {success:true})', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const openUrlListeners = await appListenersFor('open-url');
    expect(openUrlListeners.length).toBeGreaterThanOrEqual(1);

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    // First BrowserWindow = mainWindow (see createMainWindow() is called first).
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };

    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;
    openUrlListeners[0].listener(fakeEvent, 'roselabs://payment-success');

    expect(mainInstance.webContents.send).toHaveBeenCalledWith('payment-complete', {
      success: true,
    });

    // And payment-cancel sends success:false
    (mainInstance.webContents.send as ReturnType<typeof vi.fn>).mockClear();
    openUrlListeners[0].listener(fakeEvent, 'roselabs://payment-cancel');
    expect(mainInstance.webContents.send).toHaveBeenCalledWith('payment-complete', {
      success: false,
    });
  });

  it('deep-link: open restores the app and selects the web-started agent', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const openUrlListeners = await appListenersFor('open-url');
    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      isMinimized: ReturnType<typeof vi.fn>;
      restore: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      moveTop: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    mainInstance.isMinimized.mockReturnValue(true);

    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;
    openUrlListeners[0].listener(fakeEvent, 'roselabs://open?agent-id=agent-from-web');

    expect(mainInstance.restore).toHaveBeenCalledTimes(1);
    expect(mainInstance.show).toHaveBeenCalled();
    expect(mainInstance.moveTop).toHaveBeenCalled();
    expect(mainInstance.focus).toHaveBeenCalled();
    expect(mainInstance.webContents.send).toHaveBeenCalledWith('open-agent', 'agent-from-web');
  });

  it('deep-link: open-url before app readiness creates the window and selects the agent', async () => {
    await loadMainEntry((electron) => {
      vi.mocked(electron.app.isReady).mockReturnValue(false);
    });

    const openUrlListeners = await appListenersFor('open-url');
    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;

    openUrlListeners[0].listener(fakeEvent, 'roselabs://open?agent-id=cold-start-agent');

    expect(fakeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(BrowserWindow).not.toHaveBeenCalled();

    vi.mocked(electron.app.isReady).mockReturnValue(true);
    await flushWhenReady();

    expect(BrowserWindow).toHaveBeenCalledTimes(2);
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    expect(mainInstance.webContents.send).toHaveBeenCalledWith('open-agent', 'cold-start-agent');
  });

  it('deep-link: open recreates a closed main window before selecting the agent', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const openUrlListeners = await appListenersFor('open-url');
    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const originalMain = BrowserWindow.mock.results[0]?.value as {
      on: ReturnType<typeof vi.fn>;
    };
    const closedListener = originalMain.on.mock.calls.find(([event]) => event === 'closed')?.[1] as
      (() => void) | undefined;
    expect(closedListener).toBeDefined();
    closedListener?.();

    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;
    openUrlListeners[0].listener(fakeEvent, 'roselabs://open?agent-id=agent-after-close');

    expect(BrowserWindow).toHaveBeenCalledTimes(3);
    const reopenedMain = BrowserWindow.mock.results[2]?.value as {
      show: ReturnType<typeof vi.fn>;
      moveTop: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      webContents: {
        once: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      };
    };
    expect(reopenedMain.show).toHaveBeenCalled();
    expect(reopenedMain.moveTop).toHaveBeenCalled();
    expect(reopenedMain.focus).toHaveBeenCalled();
    const didFinishLoad = reopenedMain.webContents.once.mock.calls.find(
      ([event]) => event === 'did-finish-load'
    )?.[1] as (() => void) | undefined;
    expect(didFinishLoad).toBeDefined();
    expect(reopenedMain.webContents.send).not.toHaveBeenCalledWith(
      'open-agent',
      'agent-after-close'
    );

    didFinishLoad?.();
    expect(reopenedMain.webContents.send).toHaveBeenCalledWith('open-agent', 'agent-after-close');
  });

  // Closing the main window leaves Rose running on macOS, so the global
  // shortcut still opens the launcher. Its submit used to be discarded.
  it('quick-query: submit recreates a closed main window, whose renderer then takes the query', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const originalMain = BrowserWindow.mock.results[0]?.value as {
      on: ReturnType<typeof vi.fn>;
      webContents: unknown;
    };
    const closedListener = originalMain.on.mock.calls.find(([event]) => event === 'closed')?.[1] as
      (() => void) | undefined;
    expect(closedListener).toBeDefined();
    closedListener?.();

    const submit = await quickQueryHandler('quick-query:submit');
    expect(submit({}, { query: 'book a table for two', submittedAt: 7 })).toEqual({
      success: true,
    });

    expect(BrowserWindow).toHaveBeenCalledTimes(3);
    const reopenedMain = BrowserWindow.mock.results[2]?.value as {
      show: ReturnType<typeof vi.fn>;
      moveTop: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      webContents: unknown;
    };
    expect(reopenedMain.show).toHaveBeenCalled();
    expect(reopenedMain.moveTop).toHaveBeenCalled();
    expect(reopenedMain.focus).toHaveBeenCalled();

    const take = await quickQueryHandler('quick-query:take');
    const claim = await quickQueryHandler('quick-query:claim');
    expect(take({ sender: originalMain.webContents })).toEqual([]);
    const held = take({ sender: reopenedMain.webContents }) as Array<{
      id: string;
      payload: unknown;
    }>;
    expect(held.map((entry) => entry.payload)).toEqual([
      { query: 'book a table for two', submittedAt: 7 },
    ]);
    expect(claim({ sender: reopenedMain.webContents }, held[0]?.id)).toEqual({ claimed: true });
    expect(take({ sender: reopenedMain.webContents })).toEqual([]);
  });

  it('quick-query: submit restores a minimized main window and tells it a query is waiting', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const main = vi.mocked(electron.BrowserWindow).mock.results[0]?.value as {
      isMinimized: ReturnType<typeof vi.fn>;
      restore: ReturnType<typeof vi.fn>;
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    main.isMinimized.mockReturnValue(true);
    main.restore.mockClear();
    main.webContents.send.mockClear();

    const submit = await quickQueryHandler('quick-query:submit');
    submit({}, { query: 'find my flight', submittedAt: 8 });

    expect(main.restore).toHaveBeenCalled();
    expect(main.webContents.send.mock.calls).toEqual([['quick-query:pending']]);
    const take = await quickQueryHandler('quick-query:take');
    const held = take({ sender: main.webContents }) as Array<{ payload: unknown }>;
    expect(held.map((entry) => entry.payload)).toEqual([
      { query: 'find my flight', submittedAt: 8 },
    ]);
  });

  it('deep-link: open selects the agent immediately when only an embedded frame is loading', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const openUrlListeners = await appListenersFor('open-url');
    const electron = await import('electron');
    const main = vi.mocked(electron.BrowserWindow).mock.results[0]?.value as {
      webContents: {
        isLoading: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      };
    };
    main.webContents.isLoading.mockReturnValue(true);

    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;
    openUrlListeners[0].listener(fakeEvent, 'roselabs://open?agent-id=agent-live-view');

    expect(main.webContents.send).toHaveBeenCalledWith('open-agent', 'agent-live-view');
  });

  it('deep-link: malformed URL is swallowed (no throw, no send)', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const openUrlListeners = await appListenersFor('open-url');
    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    (mainInstance.webContents.send as ReturnType<typeof vi.fn>).mockClear();

    const fakeEvent = { preventDefault: vi.fn() } as unknown as Electron.Event;
    expect(() => openUrlListeners[0].listener(fakeEvent, 'not a valid url')).not.toThrow();
    expect(mainInstance.webContents.send).not.toHaveBeenCalled();
  });

  it('credential exchange handoff: observes will-continue and claims continue before importing', async () => {
    await loadMainEntry();

    const willContinueListeners = await appListenersFor('will-continue-activity');
    const continueListeners = await appListenersFor('continue-activity');
    expect(willContinueListeners.length).toBeGreaterThanOrEqual(1);
    expect(continueListeners.length).toBeGreaterThanOrEqual(1);

    const willEvent = { preventDefault: vi.fn() };
    willContinueListeners[0].listener(willEvent, 'ASCredentialExchangeActivity');
    expect(willEvent.preventDefault).not.toHaveBeenCalled();

    const continueEvent = { preventDefault: vi.fn() };
    continueListeners[0].listener(
      continueEvent,
      'ASCredentialExchangeActivity',
      {},
      { webpageURL: undefined }
    );
    expect(continueEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('credential exchange handoff: imports a valid token and notifies the renderer', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const continueListeners = await appListenersFor('continue-activity');
    expect(continueListeners.length).toBeGreaterThanOrEqual(1);

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    const result = { success: true, count: 1, passkeyCount: 1, passwordCount: 0 };
    importPasskeysFromTokenMock.mockResolvedValueOnce(result);

    const continueEvent = { preventDefault: vi.fn() };
    continueListeners[0].listener(
      continueEvent,
      'ASCredentialExchangeActivity',
      { ASCredentialImportToken: '123e4567-e89b-12d3-a456-426614174099' },
      { webpageURL: undefined }
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(continueEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(importPasskeysFromTokenMock).toHaveBeenCalledWith(
      '123e4567-e89b-12d3-a456-426614174099',
      'test-access-token'
    );
    expect(mainInstance.webContents.send).toHaveBeenCalledWith('passkeys:importComplete', result);
  });

  it('credential exchange handoff: never imports this Mac credentials while impersonating', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    getSessionMock.mockResolvedValue({
      access_token: `${encode({ alg: 'HS256' })}.${encode({
        sub: 'target-user',
        act: { sub: 'operator-user' },
      })}.signature`,
    });
    await loadMainEntry();
    await flushWhenReady();

    const continueListeners = await appListenersFor('continue-activity');
    const continueEvent = { preventDefault: vi.fn() };
    continueListeners[0].listener(
      continueEvent,
      'ASCredentialExchangeActivity',
      { ASCredentialImportToken: '123e4567-e89b-12d3-a456-426614174088' },
      { webpageURL: undefined }
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(continueEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(importPasskeysFromTokenMock).not.toHaveBeenCalled();
  });

  it('credential exchange handoff: ignores duplicate deliveries for the same token', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const continueListeners = await appListenersFor('continue-activity');
    expect(continueListeners.length).toBeGreaterThanOrEqual(1);

    const token = '123e4567-e89b-12d3-a456-426614174077';
    const continueEvent = { preventDefault: vi.fn() };
    continueListeners[0].listener(
      continueEvent,
      'ASCredentialExchangeActivity',
      { ASCredentialImportToken: token },
      { webpageURL: undefined }
    );
    continueListeners[0].listener(
      continueEvent,
      'ASCredentialExchangeActivity',
      { ASCredentialImportToken: token.toUpperCase() },
      { webpageURL: undefined }
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(importPasskeysFromTokenMock).toHaveBeenCalledTimes(1);
    expect(importPasskeysFromTokenMock).toHaveBeenCalledWith(token, 'test-access-token');
  });

  it('credential exchange handoff: second-instance focuses the existing window', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const secondInstanceListeners = await appListenersFor('second-instance');
    expect(secondInstanceListeners.length).toBeGreaterThanOrEqual(1);

    const electron = await import('electron');
    const BrowserWindow = vi.mocked(electron.BrowserWindow);
    const mainInstance = BrowserWindow.mock.results[0]?.value as {
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
    };
    const showCallsBefore = mainInstance.show.mock.calls.length;
    const focusCallsBefore = mainInstance.focus.mock.calls.length;

    secondInstanceListeners[0].listener();

    expect(mainInstance.show).toHaveBeenCalledTimes(showCallsBefore + 1);
    expect(mainInstance.focus).toHaveBeenCalledTimes(focusCallsBefore + 1);
  });

  // ── Error state: BrowserWindow creation failure ──────────────────────────

  it('error state: BrowserWindow constructor throwing does NOT crash module-load', async () => {
    // whenReady stubbed to a never-resolving Promise so the throw inside its
    // .then() cannot escape into the test runner as an unhandled rejection,
    // while BrowserWindow is configured to throw. We still expect the
    // module-load wiring (app.on, protocol registration) to complete.
    await expect(
      loadMainEntry((electron) => {
        vi.mocked(electron.app.whenReady).mockImplementation(() => new Promise<void>(() => {}));
        vi.mocked(electron.BrowserWindow).mockImplementation(() => {
          throw new Error('native window failure');
        });
      })
    ).resolves.toBeUndefined();

    const closeListeners = await appListenersFor('window-all-closed');
    expect(closeListeners.length).toBeGreaterThanOrEqual(1);
  });

  // ── Lifecycle: will-quit unregisters shortcuts ──────────────────────────

  it('will-quit: invoking the listener unregisters all global shortcuts', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const willQuitListeners = await appListenersFor('will-quit');
    expect(willQuitListeners.length).toBeGreaterThanOrEqual(1);

    const electron = await import('electron');
    const unregisterAll = vi.mocked(electron.globalShortcut.unregisterAll);
    unregisterAll.mockClear();
    willQuitListeners[0].listener();
    expect(unregisterAll).toHaveBeenCalledTimes(1);
  });

  // ── Lifecycle: window-all-closed quits on non-darwin ─────────────────────

  it('window-all-closed: quits app on linux, does NOT quit on darwin', async () => {
    await loadMainEntry();
    await flushWhenReady();

    const electron = await import('electron');
    const quit = vi.mocked(electron.app.quit);
    quit.mockClear();

    // darwin case
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const listenersDarwin = await appListenersFor('window-all-closed');
    listenersDarwin[0].listener();
    expect(quit).not.toHaveBeenCalled();

    // linux case
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    listenersDarwin[0].listener();
    expect(quit).toHaveBeenCalledTimes(1);

    // Restore darwin for subsequent tests.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  // ── Boundary capture: main-process fetch surface ─────────────────────────
  //
  // electron-main itself does not perform outbound fetches at module-load or
  // whenReady time — all HTTP traffic is delegated to downstream services
  // (autoUpdater, registry handlers) which are mocked above. We install the
  // fetch-capture harness and assert the count is zero, which is itself a
  // meaningful contract: the wiring layer must NOT leak ad-hoc HTTP calls.
  it('boundary capture: zero outbound fetches from the wiring layer', async () => {
    const restore = installFetchCapture({});
    try {
      clearFetchCaptures();
      await loadMainEntry();
      await flushWhenReady();
      expect(fetchCaptures.length).toBe(0);
    } finally {
      restore();
    }
  });
});
