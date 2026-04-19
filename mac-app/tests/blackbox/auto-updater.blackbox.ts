/**
 * Blackbox tests for the `auto-updater` domain.
 *
 * Entry: main/services/autoUpdater.ts
 * Type:  main-service
 *
 * Observable surface we exercise:
 *   - Module initialisation (`initAutoUpdater`):
 *       * in dev mode, emits `{ state: 'idle' }` and does NOT configure the
 *         electron-updater feed URL or register event listeners
 *       * in production, configures the feed URL against the Supabase Releases
 *         endpoint with provider=generic and autoDownload=false
 *       * registers the `did-finish-load` listener so the first check fires
 *         after the renderer finishes loading
 *   - Event translation — for each raw electron-updater event, assert the
 *     `update:status` and `update:progress` payloads that get forwarded to the
 *     renderer via `mainWindow.webContents.send(...)`:
 *       * `checking-for-update` -> { state: 'checking' }
 *       * `update-available`    -> { state: 'available', version }
 *       * `update-not-available`-> { state: 'none' }
 *       * `download-progress`   -> { state: 'downloading', percent } plus
 *                                  a numeric `update:progress` channel payload
 *       * `update-downloaded`   -> { state: 'downloaded', version }, latches
 *         `isUpdateDownloaded()` to true and pins `pendingVersion` so later
 *         events still surface the version
 *       * `error` (generic)     -> { state: 'error', message }
 *       * `error` with missing channel file -> { state: 'none' } (treated as
 *         up-to-date, not an error)
 *       * `error` after `update-downloaded` is suppressed (already-downloaded
 *         state must not be overwritten)
 *   - Manual entry points:
 *       * `manualCheckForUpdates()` / `checkForUpdates()` call
 *         `autoUpdater.checkForUpdates()` and emit `{ state: 'none' }` when the
 *         check returns no updateInfo, `{ state: 'error', message }` on
 *         thrown errors, or `{ state: 'error', message: 'Auto-updates are
 *         disabled in development mode.' }` when isDev=true
 *       * `downloadUpdate()` emits `{ state: 'downloading' }` then awaits
 *         `autoUpdater.downloadUpdate()`; missing-channel-file errors are
 *         swallowed as `{ state: 'none' }`; errors after a successful download
 *         are suppressed
 *       * `restartToUpdate()` only invokes `quitAndInstall(false, true)` after
 *         an update has been downloaded
 *   - IPC registration (`registerUpdateIpc`):
 *       * registers exactly `updates:check`, `updates:download`, `updates:install`
 *       * each handler returns `{ success: true }` and forwards to the matching
 *         public function
 *       * second call is a no-op (guarded by `ipcRegistered`)
 *
 * Third-party boundary:
 *   The domain does not call `fetch()` directly — electron-updater owns the
 *   HTTP transport. Our boundary assertion is therefore on the exact arguments
 *   passed to `autoUpdater.setFeedURL(...)` (provider + URL), which is the
 *   parameter contract between us and electron-updater, and on the
 *   `mainWindow.webContents.send(...)` channel/payload contract between the
 *   main process and the renderer.
 *
 * Scope deferrals (documented in the PR body, not tested here):
 *   flake×5, concurrent-invocation, negative-control, broader-suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatusPayload } from '../../shared/types/ipc';

// ── Hoisted mock state ──────────────────────────────────────────────────────
// Declared via `vi.hoisted` so references survive `vi.resetModules()` and are
// available when vi.mock factories run at module-graph top (which is earlier
// than regular top-level `const` bindings in this file).

const updaterState = vi.hoisted(() => ({
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
}));

const checkForUpdatesFn = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const downloadUpdateFn = vi.hoisted(() => vi.fn<() => Promise<void>>());
const setFeedURLFn = vi.hoisted(() => vi.fn());
const quitAndInstallFn = vi.hoisted(() => vi.fn());

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

const configState = vi.hoisted(() => ({ isDev: false }));

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true, // real default — initAutoUpdater flips this to false
    autoInstallOnAppQuit: false,
    setFeedURL: setFeedURLFn,
    checkForUpdates: checkForUpdatesFn,
    downloadUpdate: downloadUpdateFn,
    quitAndInstall: quitAndInstallFn,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      const list = updaterState.listeners.get(event) ?? [];
      list.push(cb);
      updaterState.listeners.set(event, list);
    },
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcState.handlers.set(channel, handler);
    },
    on: vi.fn(),
    removeHandler: (channel: string) => {
      ipcState.handlers.delete(channel);
    },
  },
  BrowserWindow: vi.fn(),
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/mac-app-test'),
  },
}));

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'http://localhost:3001',
    supabase: { url: 'https://test.supabase.co', anonKey: 'test-anon-key' },
    encryptionKey: 'test-key',
    get isDev() {
      return configState.isDev;
    },
  },
}));

// ── Test helpers ────────────────────────────────────────────────────────────

type WebContentsSend = (channel: string, payload: unknown) => void;

interface FakeWebContents {
  send: ReturnType<typeof vi.fn<WebContentsSend>>;
  once: ReturnType<typeof vi.fn>;
  onceListeners: Map<string, Array<() => void>>;
}

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  webContents: FakeWebContents;
}

function makeFakeWindow(): FakeWindow {
  const onceListeners = new Map<string, Array<() => void>>();
  const send = vi.fn<WebContentsSend>();
  const once = vi.fn((event: string, cb: () => void) => {
    const list = onceListeners.get(event) ?? [];
    list.push(cb);
    onceListeners.set(event, list);
  });
  return {
    isDestroyed: vi.fn<() => boolean>(() => false),
    webContents: { send, once, onceListeners },
  };
}

function fireUpdaterEvent(event: string, ...args: unknown[]): void {
  const list = updaterState.listeners.get(event) ?? [];
  for (const cb of list) cb(...args);
}

/** Filter webContents.send calls for the update:* channels we care about. */
function statusSends(win: FakeWindow): UpdateStatusPayload[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === 'update:status')
    .map((c) => c[1] as UpdateStatusPayload);
}

function progressSends(win: FakeWindow): Array<{ percent: number }> {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === 'update:progress')
    .map((c) => c[1] as { percent: number });
}

type AutoUpdaterModule = typeof import('../../main/services/autoUpdater');

/**
 * Reload the autoUpdater module in a clean registry so module-level state
 * (updateDownloaded, pendingVersion, ipcRegistered, mainWindow) is reset
 * between tests. `updaterState.listeners` and `ipcState.handlers` are cleared
 * in tandem so each reload starts with an empty event/IPC surface.
 */
async function loadAutoUpdater(): Promise<AutoUpdaterModule> {
  updaterState.listeners.clear();
  ipcState.handlers.clear();
  vi.resetModules();
  return (await import('../../main/services/autoUpdater')) as AutoUpdaterModule;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('blackbox: auto-updater (main-service)', () => {
  let win: FakeWindow;

  beforeEach(() => {
    configState.isDev = false;
    win = makeFakeWindow();
    // Reset mock state WITHOUT detaching the fns from the electron-updater
    // factory (mockReset preserves identity).
    checkForUpdatesFn.mockReset();
    downloadUpdateFn.mockReset();
    setFeedURLFn.mockReset();
    quitAndInstallFn.mockReset();
  });

  // ── initAutoUpdater ───────────────────────────────────────────────────────
  describe('initAutoUpdater', () => {
    it('in dev mode emits idle status and does not configure electron-updater', async () => {
      configState.isDev = true;
      const mod = await loadAutoUpdater();

      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      expect(statusSends(win)).toEqual([{ state: 'idle', version: undefined }]);
      expect(setFeedURLFn).not.toHaveBeenCalled();
      // In dev we never register electron-updater listeners.
      expect(updaterState.listeners.size).toBe(0);
    });

    it('in production configures the Supabase generic feed URL and disables auto-download', async () => {
      const mod = await loadAutoUpdater();

      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      const electronUpdater = await import('electron-updater');
      expect(setFeedURLFn).toHaveBeenCalledTimes(1);
      expect(setFeedURLFn).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://test.supabase.co/storage/v1/object/public/Releases/mac/latest',
      });
      expect(electronUpdater.autoUpdater.autoDownload).toBe(false);
      expect(electronUpdater.autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it('registers listeners for every event the service translates', async () => {
      const mod = await loadAutoUpdater();

      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      for (const event of [
        'checking-for-update',
        'update-available',
        'update-not-available',
        'download-progress',
        'update-downloaded',
        'error',
      ]) {
        expect(
          updaterState.listeners.get(event)?.length ?? 0,
          `listener missing for ${event}`
        ).toBeGreaterThan(0);
      }
    });

    it('schedules the first check via did-finish-load (renderer-ready gate)', async () => {
      vi.useFakeTimers();
      try {
        const mod = await loadAutoUpdater();
        checkForUpdatesFn.mockResolvedValue({ updateInfo: null });

        mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

        expect(win.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        // Fire did-finish-load manually and advance the 500ms delay.
        const finishCb = win.webContents.onceListeners.get('did-finish-load')?.[0];
        expect(finishCb).toBeDefined();
        finishCb?.();
        await vi.advanceTimersByTimeAsync(500);

        expect(checkForUpdatesFn).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Event translation ────────────────────────────────────────────────────
  describe('event translation', () => {
    it('translates checking-for-update into state=checking', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      fireUpdaterEvent('checking-for-update');

      expect(statusSends(win)).toEqual([{ state: 'checking', version: undefined }]);
    });

    it('translates update-available into state=available with the version', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      fireUpdaterEvent('update-available', { version: '1.2.3' });

      expect(statusSends(win)).toEqual([{ state: 'available', version: '1.2.3' }]);
    });

    it('translates update-not-available into state=none and clears pendingVersion', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-available', { version: '1.2.3' });
      win.webContents.send.mockClear();

      fireUpdaterEvent('update-not-available');

      expect(statusSends(win)).toEqual([{ state: 'none', version: undefined }]);
    });

    it('translates download-progress into downloading + numeric progress', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      fireUpdaterEvent('download-progress', { percent: 42.7 });

      expect(progressSends(win)).toEqual([{ percent: 42.7 }]);
      expect(statusSends(win)).toEqual([
        { state: 'downloading', percent: 42.7, version: undefined },
      ]);
    });

    it('translates update-downloaded into state=downloaded and latches isUpdateDownloaded', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      expect(mod.isUpdateDownloaded()).toBe(false);
      win.webContents.send.mockClear();

      fireUpdaterEvent('update-downloaded', { version: '2.0.0' });

      expect(mod.isUpdateDownloaded()).toBe(true);
      expect(statusSends(win)).toEqual([{ state: 'downloaded', version: '2.0.0' }]);
    });

    it('pins pendingVersion after update-downloaded so later status messages keep the version', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-downloaded', { version: '2.0.0' });
      win.webContents.send.mockClear();

      fireUpdaterEvent('checking-for-update');

      // pendingVersion is carried forward via sendStatus.
      expect(statusSends(win)).toEqual([{ state: 'checking', version: '2.0.0' }]);
    });

    it('translates generic errors into state=error with the message', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      fireUpdaterEvent('error', new Error('network down'));

      expect(statusSends(win)).toEqual([
        { state: 'error', message: 'network down', version: undefined },
      ]);
    });

    it('treats missing latest-mac.yml as up-to-date (no error surfaced to renderer)', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      const err = Object.assign(new Error('boom'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      });

      fireUpdaterEvent('error', err);

      expect(statusSends(win)).toEqual([{ state: 'none', version: undefined }]);
    });

    it('also treats latest-mac.yml substring errors as up-to-date when code is absent', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      fireUpdaterEvent('error', new Error('could not parse latest-mac.yml'));

      expect(statusSends(win)).toEqual([{ state: 'none', version: undefined }]);
    });

    it('ignores errors that fire after update-downloaded (downloaded state must stick)', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-downloaded', { version: '3.0.0' });
      win.webContents.send.mockClear();

      fireUpdaterEvent('error', new Error('late failure'));

      expect(statusSends(win)).toEqual([]);
      expect(mod.isUpdateDownloaded()).toBe(true);
    });

    it('does not send to a destroyed window', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      win.isDestroyed.mockReturnValue(true);

      fireUpdaterEvent('update-available', { version: '9.9.9' });

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  // ── Manual check ─────────────────────────────────────────────────────────
  describe('manualCheckForUpdates / checkForUpdates', () => {
    it('rejects in dev mode with a user-visible error message', async () => {
      configState.isDev = true;
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      await mod.manualCheckForUpdates();

      expect(statusSends(win)).toEqual([
        {
          state: 'error',
          message: 'Auto-updates are disabled in development mode.',
          version: undefined,
        },
      ]);
      expect(checkForUpdatesFn).not.toHaveBeenCalled();
    });

    it('emits checking then none when electron-updater returns no updateInfo', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      checkForUpdatesFn.mockResolvedValue(null);

      await mod.manualCheckForUpdates();

      expect(statusSends(win)).toEqual([
        { state: 'checking', version: undefined },
        { state: 'none', version: undefined },
      ]);
    });

    it('stays silent (no none) when electron-updater returns an updateInfo payload (event listeners drive the UI)', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      checkForUpdatesFn.mockResolvedValue({ updateInfo: { version: '4.0.0' } });

      await mod.manualCheckForUpdates();

      expect(statusSends(win)).toEqual([{ state: 'checking', version: undefined }]);
    });

    it('emits checking then error when electron-updater throws a generic error', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      checkForUpdatesFn.mockRejectedValue(new Error('dns failed'));

      await mod.manualCheckForUpdates();

      expect(statusSends(win)).toEqual([
        { state: 'checking', version: undefined },
        { state: 'error', message: 'dns failed', version: undefined },
      ]);
    });

    it('treats missing-channel-file error from checkForUpdates() as state=none', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      checkForUpdatesFn.mockRejectedValue(
        Object.assign(new Error('no channel'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
      );

      await mod.manualCheckForUpdates();

      expect(statusSends(win)).toEqual([
        { state: 'checking', version: undefined },
        { state: 'none', version: undefined },
      ]);
    });
  });

  // ── Download ─────────────────────────────────────────────────────────────
  describe('downloadUpdate', () => {
    it('no-ops in dev mode and does not touch electron-updater', async () => {
      configState.isDev = true;
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();

      await mod.downloadUpdate();

      expect(downloadUpdateFn).not.toHaveBeenCalled();
      expect(statusSends(win)).toEqual([]);
    });

    it('emits state=downloading then delegates to autoUpdater.downloadUpdate()', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      downloadUpdateFn.mockResolvedValue();

      await mod.downloadUpdate();

      expect(downloadUpdateFn).toHaveBeenCalled();
      expect(statusSends(win)).toEqual([{ state: 'downloading', version: undefined }]);
    });

    it('maps download failure to state=error with the message', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      downloadUpdateFn.mockRejectedValue(new Error('disk full'));

      await mod.downloadUpdate();

      expect(statusSends(win)).toEqual([
        { state: 'downloading', version: undefined },
        { state: 'error', message: 'disk full', version: undefined },
      ]);
    });

    it('treats missing-channel-file error as state=none', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      win.webContents.send.mockClear();
      downloadUpdateFn.mockRejectedValue(new Error('missing latest-mac.yml'));

      await mod.downloadUpdate();

      expect(statusSends(win)).toEqual([
        { state: 'downloading', version: undefined },
        { state: 'none', version: undefined },
      ]);
    });

    it('suppresses the error branch when update-downloaded already fired', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-downloaded', { version: '5.0.0' });
      win.webContents.send.mockClear();
      downloadUpdateFn.mockRejectedValue(new Error('late'));

      await mod.downloadUpdate();

      // Only the downloading status is sent; the error branch returns early.
      expect(statusSends(win)).toEqual([{ state: 'downloading', version: '5.0.0' }]);
    });
  });

  // ── Restart-to-update ────────────────────────────────────────────────────
  describe('restartToUpdate', () => {
    it('is a no-op when no update has been downloaded', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      mod.restartToUpdate();
      // setImmediate (if any) drains on next microtask — but the guard
      // short-circuits before scheduling anything.
      await new Promise((r) => setImmediate(r));

      expect(quitAndInstallFn).not.toHaveBeenCalled();
    });

    it('invokes quitAndInstall(false, true) after update-downloaded', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-downloaded', { version: '6.0.0' });

      mod.restartToUpdate();
      // restartToUpdate uses setImmediate; flush one tick.
      await new Promise((r) => setImmediate(r));

      expect(quitAndInstallFn).toHaveBeenCalledWith(false, true);
    });
  });

  // ── IPC registration ─────────────────────────────────────────────────────
  describe('registerUpdateIpc', () => {
    it('registers exactly the updates:* channel surface', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      mod.registerUpdateIpc();

      expect([...ipcState.handlers.keys()].sort()).toEqual([
        'updates:check',
        'updates:download',
        'updates:install',
      ]);
    });

    it('is idempotent — second call does not re-register', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);

      mod.registerUpdateIpc();
      const firstKeys = [...ipcState.handlers.keys()].sort();
      ipcState.handlers.clear();
      mod.registerUpdateIpc();

      // Second call must NOT repopulate the handler map (guard short-circuits).
      expect(ipcState.handlers.size).toBe(0);
      expect(firstKeys).toEqual(['updates:check', 'updates:download', 'updates:install']);
    });

    it('updates:check invokes the manual check and returns { success: true }', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      mod.registerUpdateIpc();
      win.webContents.send.mockClear();
      checkForUpdatesFn.mockResolvedValue(null);

      const handler = ipcState.handlers.get('updates:check')!;
      const result = await handler({});

      expect(result).toEqual({ success: true });
      expect(checkForUpdatesFn).toHaveBeenCalled();
    });

    it('updates:download invokes downloadUpdate and returns { success: true }', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      mod.registerUpdateIpc();
      downloadUpdateFn.mockResolvedValue();

      const handler = ipcState.handlers.get('updates:download')!;
      const result = await handler({});

      expect(result).toEqual({ success: true });
      expect(downloadUpdateFn).toHaveBeenCalled();
    });

    it('updates:install is a no-op without a downloaded update but still returns { success: true }', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      mod.registerUpdateIpc();

      const handler = ipcState.handlers.get('updates:install')!;
      const result = await handler({});
      await new Promise((r) => setImmediate(r));

      expect(result).toEqual({ success: true });
      expect(quitAndInstallFn).not.toHaveBeenCalled();
    });

    it('updates:install triggers quitAndInstall when an update is downloaded', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      mod.registerUpdateIpc();
      fireUpdaterEvent('update-downloaded', { version: '7.0.0' });

      const handler = ipcState.handlers.get('updates:install')!;
      await handler({});
      await new Promise((r) => setImmediate(r));

      expect(quitAndInstallFn).toHaveBeenCalledWith(false, true);
    });
  });

  // ── setAutoUpdaterWindow ─────────────────────────────────────────────────
  describe('setAutoUpdaterWindow', () => {
    it('routes subsequent status sends to the newly-set window', async () => {
      const mod = await loadAutoUpdater();
      mod.initAutoUpdater(win as unknown as Electron.BrowserWindow);
      const newWin = makeFakeWindow();

      mod.setAutoUpdaterWindow(newWin as unknown as Electron.BrowserWindow);
      fireUpdaterEvent('update-available', { version: '8.0.0' });

      expect(statusSends(newWin)).toEqual([{ state: 'available', version: '8.0.0' }]);
      // And the original window no longer receives the update-available event.
      expect(statusSends(win).some((p) => p.state === 'available')).toBe(false);
    });
  });
});
