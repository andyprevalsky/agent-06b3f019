import { useEffect, useState } from 'react';

/**
 * Detects Safari (including iOS) via user agent. Returns `false` on
 * the first render and updates after mount so the value is never
 * out-of-sync with SSR.
 */
export function useSafariDetection(): boolean {
  const [isSafari, setIsSafari] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const detected = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('firefox');
    setIsSafari(detected);
  }, []);

  return isSafari;
}
