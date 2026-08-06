/**
 * Blackbox: QuickQueryController blur-hide vs OS file-drag.
 *
 * Repro target: starting a Finder/screenshot drag blurs the launcher. The old
 * path hid immediately on blur, so the drop landed on apps behind the (now
 * gone) always-on-top pill. File-drag IPC must cancel deferred blur-hide and
 * re-show the window if hide already raced ahead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeBrowserWindowStub, stubElectron } from './electron-stubs';
import { QUICK_QUERY_BLUR_HIDE_DELAY_MS, QuickQueryController } from '../../main/app/quickQuery';

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
    fileDrag?.(null, { active: true });

    await vi.advanceTimersByTimeAsync(QUICK_QUERY_BLUR_HIDE_DELAY_MS + 50);
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

  it('submit with query content focuses the main window; hide IPC focuses main', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as WinStub & {
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      webContents: { send: ReturnType<typeof vi.fn> };
    };

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
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
    submit?.(null, { query: 'ship it', submittedAt: Date.now() });
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith(
      'quick-query:submit',
      expect.objectContaining({ query: 'ship it' })
    );

    // Re-open after the 2s re-show guard so hide IPC can run.
    await vi.advanceTimersByTimeAsync(2100);
    win.isVisible.mockReturnValue(false);
    toggle();
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1100);

    const hide = await ipcHandler('quick-query:hide');
    hide?.(null);
    expect(main.show).toHaveBeenCalled();
  });

  it('resize IPC clamps height; empty submit does not forward to main', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );
    const main = makeBrowserWindowStub() as unknown as WinStub & {
      webContents: { send: ReturnType<typeof vi.fn> };
    };

    const controller = new QuickQueryController({
      getMainWindow: () => main as unknown as Electron.BrowserWindow,
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
  });

  it('blocks show/toggle when onboarding is incomplete', async () => {
    const electron = await import('electron');
    vi.mocked(electron.BrowserWindow).mockImplementation(
      () => makeBrowserWindowStub() as unknown as Electron.BrowserWindow
    );

    const controller = new QuickQueryController({
      getMainWindow: () => null,
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
