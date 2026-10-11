/** Per-URL iframe load state for LiveViewLoading: a new URL starts unloaded. */

import { useCallback, useState } from 'react';

export function useLiveViewLoaded(url: string): { isLoaded: boolean; onLoad: () => void } {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const onLoad = useCallback(() => setLoadedUrl(url), [url]);
  return { isLoaded: loadedUrl === url, onLoad };
}
