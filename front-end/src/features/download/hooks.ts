import { useEffect } from 'react';

import * as analytics from '@/lib/analytics';

import { DOWNLOAD_URL } from './config';

type DownloadTrigger = 'automatic_redirect' | 'fallback_link';

/** Record the installer handoff before browser navigation leaves the app. */
export function trackDownloadStarted(trigger: DownloadTrigger): void {
  analytics.track('mac_download_started', {
    artifact: 'dmg',
    channel: 'latest',
    trigger,
  });
  analytics.flush();
}

/** Triggers an immediate redirect to the Mac download URL on mount. */
export function useDownloadRedirect(): void {
  useEffect(() => {
    const flushOnPageHide = () => analytics.flush();
    window.addEventListener('pagehide', flushOnPageHide);
    trackDownloadStarted('automatic_redirect');
    window.location.href = DOWNLOAD_URL;
    return () => window.removeEventListener('pagehide', flushOnPageHide);
  }, []);
}
