/**
 * Browser connectivity signals for the connectivity-indicator feature.
 * Hooks call these; components never touch `navigator` / `window` directly.
 */

export const readIsOnline = (): boolean => navigator.onLine;

/** Subscribes to the window `online` / `offline` events; returns the disposer. */
export const subscribeToConnectivity = (callback: (isOnline: boolean) => void): (() => void) => {
  const onOnline = (): void => callback(true);
  const onOffline = (): void => callback(false);

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
};
