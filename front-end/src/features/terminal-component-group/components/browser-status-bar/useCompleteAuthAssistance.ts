/** Start Agent handler for a pending auth-assistance request (BrowserStatusBar). */

import { useCallback } from 'react';
import { completeAuthAssistanceRequest } from '../../hooks';

export function useCompleteAuthAssistance(
  setBusy: (busy: boolean) => void,
): (requestId: string) => void {
  const handleCompleteAuthAssistance = useCallback(
    async (requestId: string) => {
      setBusy(true);
      try {
        await completeAuthAssistanceRequest(requestId);
      } catch (error) {
        console.error('Failed to complete authentication assistance:', error);
      } finally {
        setBusy(false);
      }
    },
    [setBusy],
  );
  return useCallback(
    (requestId: string) => {
      void handleCompleteAuthAssistance(requestId);
    },
    [handleCompleteAuthAssistance],
  );
}
