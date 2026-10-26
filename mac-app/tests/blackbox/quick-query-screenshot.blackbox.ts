/**
 * Blackbox: Alt+Space attaches a screenshot of the screen it was pressed on.
 *
 * The capture must happen while the launcher is still hidden (otherwise the
 * pill is in the shot), must come from the display under the cursor (where
 * the launcher opens), and must never stop the launcher from opening: missing
 * macOS Screen Recording access, a failed capture or a hung capture all open
 * it without a screenshot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeBrowserWindowStub, stubElectron } from './electron-stubs';
import { QuickQueryController } from '../../main/app/quickQuery';
import { QUICK_QUERY_SCREENSHOT_TIMEOUT_MS } from '../../main/app/quickQueryScreenshot';
import type { QuickQueryToggleState } from '../../shared/types/ipc';

stubElectron();

vi.mock('../../main/base/config', () => ({
  config: { isDev: false },
}));

vi.mock('../../main/app/packagedPaths', () => ({
  getPackagedRendererPath: (file: string) => `/tmp/test-ui/${file}`,
}));

type WinStub = {
  show: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function thumbnail(bytes: number[]) {
  return { isEmpty: () => bytes.length === 0, toPNG: () => Buffer.from(bytes) };
}

async function openLauncher(): Promise<{ win: WinStub; toggle: () => void }> {
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
  controller.registerGlobalShortcuts();
  const match = vi
    .mocked(electron.globalShortcut.register)
    .mock.calls.find((call) => call[0] === 'Alt+Space');
  return { win, toggle: match?.[1] as () => void };
}

function toggleStates(win: WinStub): QuickQueryToggleState[] {
  return win.webContents.send.mock.calls
    .filter((call) => call[0] === 'quick-query:toggle')
    .map((call) => call[1] as QuickQueryToggleState);
}

describe('QuickQueryController open-time screenshot', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T15:04:09'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: realPlatform });
    const electron = await import('electron');
    vi.mocked(electron.desktopCapturer.getSources).mockImplementation(() => Promise.resolve([]));
    vi.mocked(electron.systemPreferences.getMediaAccessStatus).mockReturnValue('granted');
  });

  it('captures the display under the cursor before showing, and sends it with the open', async () => {
    const electron = await import('electron');
    vi.mocked(electron.screen.getDisplayNearestPoint).mockReturnValueOnce({
      id: 7,
      size: { width: 1512, height: 982 },
      workArea: { x: 0, y: 0, width: 1512, height: 950 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
    } as unknown as Electron.Display);
    const { win, toggle } = await openLauncher();
    let shownBeforeCapture: number | null = null;
    vi.mocked(electron.desktopCapturer.getSources).mockImplementation(async () => {
      shownBeforeCapture = win.show.mock.calls.length;
      return [
        { display_id: '3', thumbnail: thumbnail([0x01]) },
        { display_id: '7', thumbnail: thumbnail(PNG_BYTES) },
      ] as unknown as Electron.DesktopCapturerSource[];
    });

    toggle();
    await vi.advanceTimersByTimeAsync(0);

    expect(electron.desktopCapturer.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1512, height: 982 },
    });
    expect(shownBeforeCapture).toBe(0);
    expect(win.show).toHaveBeenCalledTimes(1);

    const [opened] = toggleStates(win);
    expect(opened?.open).toBe(true);
    expect(opened?.screenshot).toMatchObject({
      name: 'Screenshot 2026-10-24 at 15.04.09.png',
      mimeType: 'image/png',
      size: PNG_BYTES.length,
      autoCaptured: true,
    });
    // A plain ArrayBuffer (not a Node Buffer view), as QuickQueryAttachment declares.
    // jsdom has its own ArrayBuffer global, so compare the tag, not instanceof.
    expect(Object.prototype.toString.call(opened?.screenshot?.data)).toBe('[object ArrayBuffer]');
    expect(Array.from(new Uint8Array(opened?.screenshot?.data ?? new ArrayBuffer(0)))).toEqual(
      PNG_BYTES
    );
  });

  it('opens without a screenshot when macOS Screen Recording is not granted, prompting once', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const electron = await import('electron');
    vi.mocked(electron.systemPreferences.getMediaAccessStatus).mockReturnValue('denied');
    const { win, toggle } = await openLauncher();

    toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(toggleStates(win)).toEqual([{ open: true }]);
    // One tiny request so macOS shows its prompt; the wallpaper-only frame is discarded.
    expect(electron.desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    expect(electron.desktopCapturer.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });

    // Close (past the 1s show grace), then reopen (past the 2s re-show guard).
    win.isVisible.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1_100);
    toggle();
    win.isVisible.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2_100);
    toggle();
    await vi.advanceTimersByTimeAsync(0);

    expect(win.show).toHaveBeenCalledTimes(2);
    expect(toggleStates(win)).toEqual([{ open: true }, { open: false }, { open: true }]);
    expect(electron.desktopCapturer.getSources).toHaveBeenCalledTimes(1);
  });

  it('opens without a screenshot when the capture fails', async () => {
    const electron = await import('electron');
    vi.mocked(electron.desktopCapturer.getSources).mockRejectedValue(new Error('capture failed'));
    const { win, toggle } = await openLauncher();

    toggle();
    await vi.advanceTimersByTimeAsync(0);

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(toggleStates(win)).toEqual([{ open: true }]);
  });

  it('opens without a screenshot once a hung capture hits its timeout', async () => {
    const electron = await import('electron');
    vi.mocked(electron.desktopCapturer.getSources).mockReturnValue(new Promise(() => {}));
    const { win, toggle } = await openLauncher();

    toggle();
    await vi.advanceTimersByTimeAsync(QUICK_QUERY_SCREENSHOT_TIMEOUT_MS - 1);
    expect(win.show).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(toggleStates(win)).toEqual([{ open: true }]);
  });

  it('ignores repeat presses while a capture is in flight', async () => {
    const electron = await import('electron');
    let finishCapture: (sources: Electron.DesktopCapturerSource[]) => void = () => {};
    vi.mocked(electron.desktopCapturer.getSources).mockReturnValue(
      new Promise((resolve) => {
        finishCapture = resolve;
      })
    );
    const { win, toggle } = await openLauncher();

    toggle();
    toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.desktopCapturer.getSources).toHaveBeenCalledTimes(1);

    finishCapture([
      { display_id: '1', thumbnail: thumbnail(PNG_BYTES) },
    ] as unknown as Electron.DesktopCapturerSource[]);
    await vi.advanceTimersByTimeAsync(0);

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(toggleStates(win)).toHaveLength(1);
    expect(toggleStates(win)[0]?.screenshot?.mimeType).toBe('image/png');
  });
});
