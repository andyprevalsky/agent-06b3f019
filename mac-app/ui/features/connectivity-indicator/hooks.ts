import { useEffect, useState } from 'react';

export interface UseConnectivityStatusResult {
  isOnline: boolean;
}

/**
 * Tracks browser connectivity via `navigator.onLine` and the window
 * `online` / `offline` events.
 */
export const useConnectivityStatus = (): UseConnectivityStatusResult => {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const onOnline = (): void => setIsOnline(true);
    const onOffline = (): void => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return { isOnline };
};
