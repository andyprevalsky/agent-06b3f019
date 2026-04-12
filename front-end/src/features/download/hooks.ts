import { useEffect } from 'react';

import { DOWNLOAD_URL } from './config';

/** Triggers an immediate redirect to the Mac download URL on mount. */
export function useDownloadRedirect(): void {
  useEffect(() => {
    window.location.href = DOWNLOAD_URL;
  }, []);
}
