import { useEffect, useState } from 'react';
import { readIsOnline, subscribeToConnectivity } from './api';
import type { UseConnectivityStatusResult } from './types';

/**
 * Tracks browser connectivity via `navigator.onLine` and the window
 * `online` / `offline` events.
 */
export const useConnectivityStatus = (): UseConnectivityStatusResult => {
  const [isOnline, setIsOnline] = useState(readIsOnline);

  useEffect(() => subscribeToConnectivity(setIsOnline), []);

  return { isOnline };
};
