/**
 * Geometry helpers for the quick-query BrowserWindow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeBrowserWindowStub, stubElectron } from './electron-stubs';
import {
  applyQuickQueryWindowHeight,
  getDevLauncherUrl,
  parseFileDragActive,
  positionQuickQueryWindow,
  resizeQuickQueryWindow,
} from '../../main/app/quickQueryGeometry';

stubElectron();

describe('quickQueryGeometry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('positions the launcher near the bottom-center of the nearest display', async () => {
    const electron = await import('electron');
    vi.mocked(electron.screen.getCursorScreenPoint).mockReturnValue({ x: 100, y: 100 });
    vi.mocked(electron.screen.getDisplayNearestPoint).mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    } as Electron.Display);

    const win = makeBrowserWindowStub() as unknown as Electron.BrowserWindow & {
      getSize: ReturnType<typeof vi.fn>;
      setPosition: ReturnType<typeof vi.fn>;
    };
    win.getSize.mockReturnValue([500, 100]);
    positionQuickQueryWindow(win);
    expect(win.setPosition).toHaveBeenCalledWith(710, 864, false);
  });

  it('resizeQuickQueryWindow rejects destroyed windows and clamps height', () => {
    expect(resizeQuickQueryWindow(null, { height: 200 })).toEqual({ success: false });

    const win = makeBrowserWindowStub() as unknown as Electron.BrowserWindow & {
      isDestroyed: ReturnType<typeof vi.fn>;
      setContentSize: ReturnType<typeof vi.fn>;
    };
    win.isDestroyed.mockReturnValue(true);
    expect(resizeQuickQueryWindow(win, { height: 200 })).toEqual({ success: false });

    win.isDestroyed.mockReturnValue(false);
    applyQuickQueryWindowHeight(win, 9999);
    expect(win.setContentSize).toHaveBeenCalledWith(500, 480);
  });

  it('parseFileDragActive and getDevLauncherUrl cover falsy / env paths', () => {
    expect(parseFileDragActive(null)).toBe(false);
    expect(parseFileDragActive({ active: false })).toBe(false);
    expect(parseFileDragActive({ active: true })).toBe(true);
    const prev = process.env.MAC_APP_PORT;
    delete process.env.MAC_APP_PORT;
    expect(getDevLauncherUrl()).toBe('http://localhost:5174/launcher.html');
    process.env.MAC_APP_PORT = '5199';
    expect(getDevLauncherUrl()).toBe('http://localhost:5199/launcher.html');
    if (prev === undefined) {
      delete process.env.MAC_APP_PORT;
    } else {
      process.env.MAC_APP_PORT = prev;
    }
  });
});
