import { app, type BrowserWindow } from 'electron';

const FOCUS_ATTEMPT_DELAYS_MS = [10, 50, 100, 150, 300, 500, 1000] as const;

/**
 * Focus the query textarea only. Never click a generic `input` — the paperclip
 * file picker is `input[type=file]` and appears first in DOM order, so the old
 * `querySelector('textarea, input')` + `.click()` opened Finder on every show.
 */
export const QUICK_QUERY_FOCUS_SCRIPT = `
(() => {
  const input = document.querySelector('textarea');
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
  }
})()
`;

/** Click the launcher content center so the renderer textarea can take focus. */
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
        .executeJavaScript(QUICK_QUERY_FOCUS_SCRIPT)
        .catch(() => undefined);
    }, delay);
    focusTimeouts.push(timeout);
  }
}
