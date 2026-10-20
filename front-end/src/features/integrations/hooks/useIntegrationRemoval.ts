/**
 * Remove-on-chip for single-row integrations (Rose Desktop).
 *
 * STATE MACHINE
 *
 *   [IDLE] --chip × (request)--> [CONFIRMING(name)] --cancel--> [IDLE]
 *   [CONFIRMING] --confirm--> [REMOVING(name)] --DELETE ok--> refetch --> [IDLE]
 *                                              --DELETE fails--> [IDLE + error]
 *
 * Gmail, Plaid and compute accounts keep their own removal flows (no confirm,
 * as today). This hook covers the providers that only have the generic
 * DELETE /api/integrations/:name, whose removal is new in the UI and hard to
 * undo (e.g. WhatsApp needs a fresh QR pairing), so it confirms first.
 */

import { useCallback, useState } from 'react';

import { deleteIntegrationApi } from '../api';

export interface PendingRemoval {
  /** Integration row name, e.g. `chrome`, `chrome_passwords`, `imessage`. */
  name: string;
  /** What the user sees in the confirm dialog, e.g. "Chrome cookies". */
  label: string;
}

export function useIntegrationRemoval(fetchIntegrations: () => Promise<void>) {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((name: string, label: string) => {
    setError(null);
    setPending({ name, label });
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(async () => {
    if (pending === null) return;
    const { name } = pending;
    setPending(null);
    setRemovingName(name);
    try {
      await deleteIntegrationApi(name);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove account');
    } finally {
      setRemovingName(null);
    }
  }, [pending, fetchIntegrations]);

  return { pending, removingName, error, request, cancel, confirm } as const;
}
