import type { BrowserWindow } from 'electron';
import Store from 'electron-store';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const windowStateStore = new Store<{ mainWindow?: WindowState }>({
  name: 'window-state',
  clearInvalidConfig: true,
  defaults: {},
});

export function getWindowState(): WindowState {
  return windowStateStore.get('mainWindow') ?? { width: 1800, height: 800 };
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  windowStateStore.set('mainWindow', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  });
}
