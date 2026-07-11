export const MAC_APP_FALLBACK_DELAY_MS = 1_500;

interface MacAppHandoffOptions {
  openApp: () => void;
  download: () => void;
  fallbackDelayMs?: number;
  windowTarget?: Window;
  documentTarget?: Document;
}

/**
 * Tries the custom protocol and falls back when the browser remains active.
 * Browsers do not expose protocol-handler availability, so losing focus or
 * becoming hidden is the success signal for handing off to the desktop app.
 */
export function attemptMacAppHandoff({
  openApp,
  download,
  fallbackDelayMs = MAC_APP_FALLBACK_DELAY_MS,
  windowTarget = window,
  documentTarget = document,
}: MacAppHandoffOptions): () => void {
  let finished = false;

  const detach = () => {
    windowTarget.removeEventListener('blur', handleAppOpened);
    documentTarget.removeEventListener('visibilitychange', handleVisibilityChange);
    clearTimeout(timeoutId);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    detach();
  };

  function handleAppOpened() {
    finish();
  }

  function handleVisibilityChange() {
    if (documentTarget.hidden) finish();
  }

  windowTarget.addEventListener('blur', handleAppOpened);
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);
  const timeoutId = setTimeout(() => {
    if (finished) return;
    const pageStayedVisible = !documentTarget.hidden;
    finish();
    if (pageStayedVisible) download();
  }, fallbackDelayMs);

  try {
    openApp();
  } catch {
    const pageIsStillActive = !finished;
    finish();
    if (pageIsStillActive) download();
  }

  return finish;
}
