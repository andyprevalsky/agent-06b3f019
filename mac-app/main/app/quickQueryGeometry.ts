import { screen, type BrowserWindow } from 'electron';
import type { QuickQueryResizePayload } from '../../shared/types/ipc';

export const LAUNCHER_WINDOW_WIDTH = 500;
export const LAUNCHER_WINDOW_HEIGHT = 100;
export const LAUNCHER_WINDOW_MAX_HEIGHT = 480;

export function positionQuickQueryWindow(quickWindow: BrowserWindow): void {
  const cursorPoint = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
  const [width] = quickWindow.getSize();
  const workArea = targetDisplay.workArea ?? targetDisplay.bounds;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + workArea.height * 0.8);
  quickWindow.setPosition(x, y, false);
}

export function applyQuickQueryWindowHeight(quickWindow: BrowserWindow, height: number): void {
  const clamped = Math.max(
    LAUNCHER_WINDOW_HEIGHT,
    Math.min(LAUNCHER_WINDOW_MAX_HEIGHT, Math.round(height))
  );
  quickWindow.setMinimumSize(LAUNCHER_WINDOW_WIDTH, LAUNCHER_WINDOW_HEIGHT);
  quickWindow.setMaximumSize(LAUNCHER_WINDOW_WIDTH, LAUNCHER_WINDOW_MAX_HEIGHT);
  quickWindow.setContentSize(LAUNCHER_WINDOW_WIDTH, clamped);
}

export function resizeQuickQueryWindow(
  quickWindow: BrowserWindow | null,
  payload: unknown
): { success: boolean } {
  if (quickWindow === null || quickWindow.isDestroyed()) {
    return { success: false };
  }

  const height =
    payload !== null &&
    typeof payload === 'object' &&
    typeof (payload as QuickQueryResizePayload).height === 'number'
      ? (payload as QuickQueryResizePayload).height
      : LAUNCHER_WINDOW_HEIGHT;

  applyQuickQueryWindowHeight(quickWindow, height);
  return { success: true };
}

export function getDevLauncherUrl(): string {
  const port = process.env.MAC_APP_PORT ?? '5174';
  return `http://localhost:${port}/launcher.html`;
}

export function parseFileDragActive(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as { active?: unknown }).active === true
  );
}
