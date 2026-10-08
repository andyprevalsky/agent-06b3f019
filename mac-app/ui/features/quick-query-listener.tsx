/**
 * Bridges launcher submits from the preload IPC channel to the shared
 * front-end quick-query consumer (Terminal's useQuickQuery).
 *
 * STATE MACHINE:
 *   [mounted] --subscribe (lists submits held in the main process)--> [listening]
 *     [listening] --submit + claim--> show Terminal route --> forward --> [listening]
 *     [listening] --unmount--> [unsubscribed]
 *
 * forward = dispatchQuickQueryEvent(payload, claim). It waits until Terminal
 * is ready, then claims the submit from the main process and delivers it. An
 * unclaimed submit stays in the main process, so a reload here loses nothing.
 */
import { useEffect } from 'react';
import { dispatchQuickQueryEvent } from '@/lib/quickQuery';
import type { QuickQueryPayload } from '../../shared/types/ipc';
import { getElectronApi } from '../lib/electron-api';

/** Terminal owns the consumer; on any other route the submit would only wait. */
function showTerminalRoute(): void {
  const route = window.location.hash.replace(/^#/, '').split('?')[0];
  if (route === '' || route === '/') return;

  const url = new URL(window.location.href);
  url.hash = '#/';
  window.history.replaceState({}, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function QuickQueryListener() {
  useEffect(() => {
    const handler = (payload: QuickQueryPayload, claim: () => Promise<boolean>) => {
      showTerminalRoute();
      dispatchQuickQueryEvent(payload, claim);
    };

    return getElectronApi()?.onQuickQuerySubmit(handler);
  }, []);

  return null;
}
