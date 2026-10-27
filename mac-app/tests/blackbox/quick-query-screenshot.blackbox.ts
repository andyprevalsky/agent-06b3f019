/**
 * Blackbox: opening the quick launcher never captures the screen or requests
 * Screen Recording access. Alt+Space → show launcher → toggle { open: true }.
 * Users can still attach files explicitly through the launcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeBrowserWindowStub, stubElectron } from './electron-stubs';
import { QuickQueryController } from '../../main/app/quickQuery';
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

describe('QuickQueryController opens without automatic screenshots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T15:04:09'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['granted', 'denied'] as const)(
    'opens immediately without capturing or checking %s Screen Recording access',
    async (access) => {
      const electron = await import('electron');
      vi.mocked(electron.systemPreferences.getMediaAccessStatus).mockReturnValue(access);
      const { win, toggle } = await openLauncher();

      toggle();

      expect(win.show).toHaveBeenCalledTimes(1);
      expect(toggleStates(win)).toEqual([{ open: true }]);
      expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
      expect(electron.systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();

      // Closing and reopening also leaves capture and permission APIs untouched.
      win.isVisible.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(1_100);
      toggle();
      win.isVisible.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(2_100);
      toggle();

      expect(win.show).toHaveBeenCalledTimes(2);
      expect(toggleStates(win)).toEqual([{ open: true }, { open: false }, { open: true }]);
      expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
      expect(electron.systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
    }
  );
});
