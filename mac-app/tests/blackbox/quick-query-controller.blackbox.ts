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
import {
  QUICK_QUERY_BLUR_HIDE_DELAY_MS,
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
  if (match?.[1] == null) {
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
});
