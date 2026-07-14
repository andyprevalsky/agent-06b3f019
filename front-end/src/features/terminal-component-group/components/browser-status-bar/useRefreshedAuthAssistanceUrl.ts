/**
 * Keeps auth-assistance browser embeds pointed at a live Steel session.
 *
 * Browser auth requests can sit in the attention inbox long enough for the
 * original Steel debug URL to expire. This hook asks the backend to validate
 * the handoff and rebind it to a resumed session when needed.
 */

import { useEffect, useState } from 'react';
import { refreshAuthAssistanceSession } from '../../hooks';
import type { PendingAuthAssistance } from './types';

export function useRefreshedAuthAssistanceUrl(
  pendingAuthAssistance: PendingAuthAssistance | null,
): string | null {
  const requestId = pendingAuthAssistance?.requestId;
  const requestedLiveViewUrl = pendingAuthAssistance?.liveViewUrl ?? null;
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(requestedLiveViewUrl);

  useEffect(() => {
    let cancelled = false;
    setLiveViewUrl(requestedLiveViewUrl);

    if (!requestId) {
      return () => {
        cancelled = true;
      };
    }

    refreshAuthAssistanceSession(requestId)
      .then((result) => {
        if (cancelled) return;
        setLiveViewUrl(
          result.liveViewUrl ?? result.handoff?.liveViewUrl ?? requestedLiveViewUrl ?? null,
        );
      })
      .catch((error) => {
        console.error('Failed to refresh auth assistance live view:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, requestedLiveViewUrl]);

  return liveViewUrl;
}
