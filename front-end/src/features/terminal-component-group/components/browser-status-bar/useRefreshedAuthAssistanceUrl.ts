/**
 * Native phone handoffs never refresh browser sessions.
 * Keeps auth-assistance browser embeds pointed at a live provider session.
 *
 * Browser auth requests can sit in the attention inbox long enough for the
 * original Steel debug URL to expire. This hook asks the backend to validate
 * the handoff and rebind it to a resumed session when needed.
 */

import { useEffect, useState } from 'react';
import { refreshAuthAssistanceSession } from '../../hooks';
import type { PendingAuthAssistance } from './types';

interface RefreshedUrlState {
  requestId: string | undefined;
  requestedLiveViewUrl: string | null;
  liveViewUrl: string | null;
}

export function useRefreshedAuthAssistanceUrl(
  pendingAuthAssistance: PendingAuthAssistance | null,
): string | null {
  const requestId = pendingAuthAssistance?.target ? undefined : pendingAuthAssistance?.requestId;
  const requestedLiveViewUrl = pendingAuthAssistance?.liveViewUrl ?? null;
  const [state, setState] = useState<RefreshedUrlState>({
    requestId,
    requestedLiveViewUrl,
    liveViewUrl: requestedLiveViewUrl,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ requestId, requestedLiveViewUrl, liveViewUrl: requestedLiveViewUrl });

    if (!requestId) {
      return () => {
        cancelled = true;
      };
    }

    refreshAuthAssistanceSession(requestId)
      .then((result) => {
        if (cancelled) return;
        setState({
          requestId,
          requestedLiveViewUrl,
          liveViewUrl:
            result.liveViewUrl ?? result.handoff?.liveViewUrl ?? requestedLiveViewUrl ?? null,
        });
      })
      .catch((error) => {
        console.error('Failed to refresh auth assistance live view:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, requestedLiveViewUrl]);

  const stateOwnsRequest =
    state.requestId === requestId && state.requestedLiveViewUrl === requestedLiveViewUrl;
  return stateOwnsRequest ? state.liveViewUrl : requestedLiveViewUrl;
}
