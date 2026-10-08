/**
 * Blackbox: QuickQueryController blur-hide vs OS file-drag.
 *
 * Repro target: starting a Finder/screenshot drag blurs the launcher. The old
 * path hid immediately on blur, so the drop landed on apps behind the (now
 * gone) always-on-top pill. File-drag IPC must cancel deferred blur-hide and
 * re-show the window if hide already raced ahead.
 *
 * Also covers submit delivery: the main window may be closed or not listening
 * yet when the launcher submits, and the query must still reach its renderer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeBrowserWindowStub, stubElectron } from './electron-stubs';
import {
  QUICK_QUERY_BLUR_HIDE_DELAY_MS,
  QUICK_QUERY_MAX_PENDING_SUBMITS,
  QuickQueryController,
} from '../../main/app/quickQuery';

stubElectron();

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: '[REDACTED]',
    supabase: { url: 'https://test.supabase.co', anonKey: 'test-anon-key' },
    encryptionKey: 'test-key',
    isDev: false,
  },
}));

vi.mock('../../main/app/packagedPaths', () => ({
  getPackagedRendererPath: (file: string) => `/tmp/test-ui/${file}`,
}));

type WinStub = ReturnType<typeof makeBrowserWindowStub> & {
  on: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  webContents: { on: ReturnType<typeof vi.fn> };
};

type MainStub = WinStub & {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
};

function windowEventHandler(win: WinStub, event: string): (() => void) | undefined {
  const match = win.on.mock.calls.find((call) => call[0] === event);
  return match?.[1] as (() => void) | undefined;
}

async function ipcHandler(
  channel: string
): Promise<((event: unknown, payload?: unknown) => unknown) | undefined> {
  const electron = await import('electron');
  const match = vi.mocked(electron.ipcMain.handle).mock.calls.find((call) => call[0] === channel);
  return match?.[1] as ((event: unknown, payload?: unknown) => unknown) | undefined;
}

async function altSpaceToggle(): Promise<() => void> {
  const electron = await import('electron');
  const match = vi
    .mocked(electron.globalShortcut.register)
    .mock.calls.find((call) => call[0] === 'Alt+Space');
  if (match?.[1] === null || match?.[1] === undefined) {
    throw new Error('Alt+Space shortcut was not registered');
  }
  return match[1] as () => void;
}

describe('QuickQueryController file-drag vs blur-hide', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // lastHiddenAt defaults to 0; real clocks are fine, but fake timers start
    // at epoch 0 and would trip the 2s re-show guard without a wall clock.
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers blur-hide and cancels it while an OS file-drag is active', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    win.isVisible.mockReturnValue(false);
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);

    // Past show grace (1000ms) + blurEnabled arm (200ms).
    await vi.advanceTimersByTimeAsync(1100);

    const blur = windowEventHandler(win, 'blur');
    expect(blur).toBeTypeOf('function');
    blur?.();
    expect(win.hide).not.toHaveBeenCalled();

    const fileDrag = await ipcHandler('quick-query:file-drag');
    expect(fileDrag).toBeTypeOf('function');
    // Mid-show focus steals are still pending; file-drag must clear them so a
    // synthetic click cannot open the paperclip Finder picker during the drag.
    const jsCallsBefore = win.webContents.executeJavaScript.mock.calls.length;
    fileDrag?.(null, { active: true });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(win.webContents.executeJavaScript.mock.calls.length).toBe(jsCallsBefore);

    await vi.advanceTimersByTimeAsync(QUICK_QUERY_BLUR_HIDE_DELAY_MS);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('keeps a multi-second blur grace so screenshot corner→launcher drags can land', () => {
    // Screenshot thumbnails spawn at a screen edge; 500ms was shorter than a
    // typical human drag to the bottom-center pill.
    expect(QUICK_QUERY_BLUR_HIDE_DELAY_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('hides on blur after the deferral when no file-drag arrives', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    windowEventHandler(win, 'blur')?.();
    expect(win.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(QUICK_QUERY_BLUR_HIDE_DELAY_MS + 50);
    expect(win.hide).toHaveBeenCalled();
  });

  it('re-shows inactive if blur-hide already hid the window before file-drag IPC', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    windowEventHandler(win, 'blur')?.();
    await vi.advanceTimersByTimeAsync(QUICK_QUERY_BLUR_HIDE_DELAY_MS + 50);
    expect(win.hide).toHaveBeenCalled();
    win.isVisible.mockReturnValue(false);

    const fileDrag = await ipcHandler('quick-query:file-drag');
    fileDrag?.(null, { active: true });
    expect(win.showInactive).toHaveBeenCalled();
  });

  it('registers will-navigate guard so file drops do not navigate the launcher', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    const willNavigate = win.webContents.on.mock.calls.find((call) => call[0] === 'will-navigate');
    expect(willNavigate?.[1]).toBeTypeOf('function');

    const event = { preventDefault: vi.fn() };
    (willNavigate?.[1] as (e: { preventDefault: () => void }) => void)(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('focus cancels a pending blur-hide; file-drag inactive is a no-op', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    windowEventHandler(win, 'blur')?.();
    windowEventHandler(win, 'focus')?.();
    await vi.advanceTimersByTimeAsync(QUICK_QUERY_BLUR_HIDE_DELAY_MS + 50);
    expect(win.hide).not.toHaveBeenCalled();

    const fileDrag = await ipcHandler('quick-query:file-drag');
    fileDrag?.(null, { active: false });
    fileDrag?.(null, { active: true });
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  it('submit opens the main window and hands it the query; hide IPC focuses main', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as MainStub;
    const openMainWindow = vi.fn();

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
      openMainWindow,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub;
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    const submit = await ipcHandler('quick-query:submit');
    expect(submit?.(null, { query: 'ship it', submittedAt: 1 })).toEqual({ success: true });
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(openMainWindow).toHaveBeenCalledTimes(1);
    // The renderer is told a submit is waiting and takes it; nothing is pushed.
    expect(main.webContents.send.mock.calls).toEqual([['quick-query:pending']]);

    const take = await ipcHandler('quick-query:take');
    expect(take?.({ sender: main.webContents })).toEqual([{ query: 'ship it', submittedAt: 1 }]);
    expect(take?.({ sender: main.webContents })).toEqual([]);

    // Re-open after the 2s re-show guard so hide IPC can run.
    await vi.advanceTimersByTimeAsync(2100);
    win.isVisible.mockReturnValue(false);
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    const hide = await ipcHandler('quick-query:hide');
    hide?.(null);
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
  });

  // Closing the main window leaves Rose running, so the launcher still opens.
  // Its submit used to be discarded because there was no window to send to.
  it('submit with the main window closed opens it and holds the query until that window takes it', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    let main: MainStub | null = null;
    const openMainWindow = vi.fn(() => {
      main = makeBrowserWindowStub() as unknown as MainStub;
    });

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow | null,
      openMainWindow,
      getOnboardingComplete: () => true,
    });
    controller.createWindow();
    controller.registerIpc();

    const submit = await ipcHandler('quick-query:submit');
    expect(submit?.(null, { query: 'ship it', submittedAt: 3 })).toEqual({ success: true });
    expect(openMainWindow).toHaveBeenCalledTimes(1);

    // The reopened window's renderer takes the query whenever it starts
    // listening; delivery never depends on how far its page has loaded.
    const reopened = main as unknown as MainStub;
    const take = await ipcHandler('quick-query:take');
    expect(take?.({ sender: reopened.webContents })).toEqual([
      { query: 'ship it', submittedAt: 3 },
    ]);
    expect(take?.({ sender: reopened.webContents })).toEqual([]);
  });

  it('keeps a submit held when no main window opened, for the next one to take', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    let main: MainStub | null = null;

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow | null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    controller.createWindow();
    controller.registerIpc();

    const submit = await ipcHandler('quick-query:submit');
    expect(submit?.(null, { query: 'nowhere to go yet', submittedAt: 5 })).toEqual({
      success: true,
    });

    const take = await ipcHandler('quick-query:take');
    const closing = makeBrowserWindowStub() as unknown as MainStub;
    closing.isDestroyed.mockReturnValue(true);
    main = closing;
    expect(take?.({ sender: closing.webContents })).toEqual([]);

    const later = makeBrowserWindowStub() as unknown as MainStub;
    main = later;
    expect(take?.({ sender: later.webContents })).toEqual([
      { query: 'nowhere to go yet', submittedAt: 5 },
    ]);
  });

  // A rejected submit re-enables the launcher input; a retry would then queue
  // the same query twice and start two agents.
  it('accepts and keeps a submit even when opening the main window throws', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as MainStub;
    const failure = new Error('window could not be created');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
      openMainWindow: () => {
        throw failure;
      },
      getOnboardingComplete: () => true,
    });
    controller.createWindow();
    controller.registerIpc();

    const submit = await ipcHandler('quick-query:submit');
    expect(submit?.(null, { query: 'held despite the failure', submittedAt: 9 })).toEqual({
      success: true,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[QuickQuery] Could not open the main window; submit stays held',
      failure
    );
    errorSpy.mockRestore();

    const take = await ipcHandler('quick-query:take');
    expect(take?.({ sender: main.webContents })).toEqual([
      { query: 'held despite the failure', submittedAt: 9 },
    ]);
    expect(take?.({ sender: main.webContents })).toEqual([]);
  });

  it('hands held submits over in order, exactly once, and only to the main window', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as MainStub;

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const launcher = controller.createWindow() as unknown as MainStub;
    controller.registerIpc();

    const submit = await ipcHandler('quick-query:submit');
    submit?.(null, { query: 'first', submittedAt: 1 });
    submit?.(null, { query: 'second', submittedAt: 2 });
    expect(main.webContents.send.mock.calls).toEqual([
      ['quick-query:pending'],
      ['quick-query:pending'],
    ]);

    const take = await ipcHandler('quick-query:take');
    expect(take?.({ sender: launcher.webContents })).toEqual([]);
    expect(take?.({ sender: main.webContents })).toEqual([
      { query: 'first', submittedAt: 1 },
      { query: 'second', submittedAt: 2 },
    ]);
    expect(take?.({ sender: main.webContents })).toEqual([]);
  });

  it('bounds held submits when the main window never takes them', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as MainStub;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    controller.createWindow();
    controller.registerIpc();

    const submit = await ipcHandler('quick-query:submit');
    for (let n = 0; n <= QUICK_QUERY_MAX_PENDING_SUBMITS; n += 1) {
      submit?.(null, { query: `query ${n}`, submittedAt: n });
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[QuickQuery] Oldest held submit dropped - main window never took it'
    );
    errorSpy.mockRestore();

    const take = await ipcHandler('quick-query:take');
    const taken = take?.({ sender: main.webContents }) as Array<{ query: string }>;
    expect(taken).toHaveLength(QUICK_QUERY_MAX_PENDING_SUBMITS);
    expect(taken[0]?.query).toBe('query 1');
    expect(taken[taken.length - 1]?.query).toBe(`query ${QUICK_QUERY_MAX_PENDING_SUBMITS}`);
  });

  it('resize IPC clamps height; empty submit does not forward to main', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as MainStub;

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub & {
      setContentSize: ReturnType<typeof vi.fn>;
    };
    controller.registerIpc();

    const resize = await ipcHandler('quick-query:resize');
    expect(resize?.(null, { height: 156 })).toEqual({ success: true });
    expect(win.setContentSize).toHaveBeenCalledWith(500, 156);
    expect(resize?.(null, null)).toEqual({ success: true });

    const submit = await ipcHandler('quick-query:submit');
    submit?.(null, { query: '   ', submittedAt: 1 });
    expect(main.webContents.send).not.toHaveBeenCalled();
    const take = await ipcHandler('quick-query:take');
    expect(take?.({ sender: main.webContents })).toEqual([]);
  });

  it('blocks show/toggle when onboarding is incomplete', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => false,
    });
    const win = controller.createWindow() as unknown as WinStub;
    controller.registerGlobalShortcuts();
    const toggle = await altSpaceToggle();
    toggle();
    expect(win.show).not.toHaveBeenCalled();
  });

  it('logs when Alt+Space is already taken and unregisters shortcuts', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    vi.mocked(electron.globalShortcut.register).mockReturnValue(false);

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    controller.createWindow();
    controller.registerGlobalShortcuts();
    controller.registerGlobalShortcuts(); // idempotent
    controller.unregisterGlobalShortcuts();
    expect(electron.globalShortcut.unregisterAll).toHaveBeenCalled();
    controller.unregisterGlobalShortcuts(); // no-op when disabled
    vi.mocked(electron.globalShortcut.register).mockReturnValue(true);
  });

  it('ignores hide during the first second after show; defers toggle while loading', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
      openMainWindow: () => undefined,
      getOnboardingComplete: () => true,
    });
    const win = controller.createWindow() as unknown as WinStub & {
      webContents: {
        isLoading: ReturnType<typeof vi.fn>;
        once: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      };
    };
    win.webContents.isLoading.mockReturnValue(true);
    controller.registerIpc();
    controller.registerGlobalShortcuts();

    const toggle = await altSpaceToggle();
    toggle();
    win.isVisible.mockReturnValue(true);
    // Still inside the 1s show grace — hide IPC must no-op.
    await vi.advanceTimersByTimeAsync(200);
    const hide = await ipcHandler('quick-query:hide');
    hide?.(null);
    expect(win.hide).not.toHaveBeenCalled();

    // configureWindow + emitToggle both register did-finish-load; the toggle
    // sender is the last one and must flush the open event when load completes.
    const onceCalls = win.webContents.once.mock.calls.filter(
      (call) => call[0] === 'did-finish-load'
    );
    expect(onceCalls.length).toBeGreaterThanOrEqual(2);
    const toggleSender = onceCalls[onceCalls.length - 1]?.[1] as () => void;
    toggleSender();
    expect(win.webContents.send).toHaveBeenCalledWith('quick-query:toggle', { open: true });
  });
});
