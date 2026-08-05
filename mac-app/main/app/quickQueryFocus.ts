import { app, type BrowserWindow } from 'electron';

const FOCUS_ATTEMPT_DELAYS_MS = [10, 50, 100, 150, 300, 500, 1000] as const;

/** Click the launcher content center so the renderer input can take focus. */
export function clickQuickQueryWindowCenter(quickWindow: BrowserWindow): void {
  const bounds = quickWindow.getBounds();
  const x = Math.round(bounds.width / 2);
  const y = Math.round(bounds.height / 2);
  quickWindow.webContents.sendInputEvent({
    type: 'mouseDown',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  quickWindow.webContents.sendInputEvent({
    type: 'mouseUp',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

/** Schedule progressive focus steals after the launcher becomes visible. */
export function scheduleQuickQueryFocusAttempts(
  quickWindow: BrowserWindow,
  focusTimeouts: NodeJS.Timeout[]
): void {
  for (const delay of FOCUS_ATTEMPT_DELAYS_MS) {
    const timeout = setTimeout(() => {
      if (quickWindow.isDestroyed()) return;
      app.focus({ steal: true });
      quickWindow.moveTop();
      quickWindow.focus();
      quickWindow.focusOnWebView();
      quickWindow.webContents.focus();
      clickQuickQueryWindowCenter(quickWindow);
      void quickWindow.webContents
        .executeJavaScript(
          `
          const input = document.querySelector('textarea, input');
          if (input) {
            input.click();
            input.focus();
          }
        `
        )
        .catch(() => undefined);
    }, delay);
    focusTimeouts.push(timeout);
  }
}
