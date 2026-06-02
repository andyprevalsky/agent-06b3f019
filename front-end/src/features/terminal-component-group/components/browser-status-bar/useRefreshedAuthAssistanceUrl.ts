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
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(
    pendingAuthAssistance?.liveViewUrl ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    setLiveViewUrl(pendingAuthAssistance?.liveViewUrl ?? null);

    if (!pendingAuthAssistance) {
      return () => {
        cancelled = true;
      };
    }

    refreshAuthAssistanceSession(pendingAuthAssistance.requestId)
      .then((result) => {
        if (cancelled) return;
        setLiveViewUrl(
          result.liveViewUrl ??
            result.handoff?.liveViewUrl ??
            pendingAuthAssistance.liveViewUrl ??
            null,
        );
      })
      .catch((error) => {
        console.error('Failed to refresh auth assistance live view:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingAuthAssistance?.requestId, pendingAuthAssistance?.liveViewUrl]);

  return liveViewUrl;
}
