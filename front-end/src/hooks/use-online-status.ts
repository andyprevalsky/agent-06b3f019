/**
 * STATE MACHINE: useOnlineStatus
 *
 * [ONLINE]  -- window 'offline' --> [OFFLINE]
 * [OFFLINE] -- window 'online'  --> [ONLINE]
 * [ANY]     -- 'visibilitychange' / 'pageshow' --> re-read navigator.onLine
 *
 * Mobile browsers can miss the online/offline events while a tab is
 * backgrounded or restored from the back-forward cache, so resuming the page
 * re-reads navigator.onLine instead of trusting the last event.
 *
 * Returns true while the browser reports a network connection.
 */

import { useSyncExternalStore } from 'react';

const WINDOW_EVENTS = ['online', 'offline', 'pageshow'] as const;

function subscribe(onChange: () => void) {
  for (const event of WINDOW_EVENTS) window.addEventListener(event, onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    for (const event of WINDOW_EVENTS) window.removeEventListener(event, onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

const readIsOnline = () => navigator.onLine;
const readServerIsOnline = () => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, readIsOnline, readServerIsOnline);
}
