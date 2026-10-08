/**
 * Bridges launcher submits from the preload IPC channel to the shared
 * front-end quick-query consumer (Terminal's useQuickQuery).
 *
 * STATE MACHINE:
 *   [mounted] --subscribe (takes submits held in the main process)--> [listening]
 *     [listening] --submit--> show Terminal route --> forward --> [listening]
 *     [listening] --unmount--> [unsubscribed]
 *
 * forward = dispatchQuickQueryEvent, which holds the submit until Terminal is
 * ready (the main window may have been re-opened for this submit).
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
    const handler = (payload: QuickQueryPayload) => {
      showTerminalRoute();
      dispatchQuickQueryEvent(payload);
    };

    return getElectronApi()?.onQuickQuerySubmit(handler);
  }, []);

  return null;
}
