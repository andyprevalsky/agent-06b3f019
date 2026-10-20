/**
 * Disconnect-on-chip for integrations without a dedicated removal flow (Rose Desktop).
 *
 * STATE MACHINE
 *
 *   [IDLE] --chip × (request)--> [CONFIRMING(target)] --cancel--> [IDLE]
 *   [CONFIRMING] --confirm--> [REMOVING(name)] --DELETE ok--> refetch full list --> [IDLE]
 *                                              --DELETE fails--> [IDLE + error]
 *   The full refetch matters: the cheap progress poll cannot see deletes.
 *
 *   DELETE /api/integrations/:name (each row has exactly one account)
 *
 * Gmail, Plaid and compute accounts keep their own existing removal flows. This
 * hook covers everything else, whose removal is hard to undo (e.g. WhatsApp
 * needs a fresh QR pairing), so it confirms first.
 */

import { useCallback, useState } from 'react';

import { deleteIntegrationApi } from '../api/accounts';

export interface PendingRemoval {
  /** Integration row name, e.g. `chrome`, `chrome_passwords`, `imessage`. */
  name: string;
  /** What the user sees in the confirm dialog, e.g. "Chrome · Default profile". */
  label: string;
}

export function useIntegrationRemoval(fetchIntegrations: () => Promise<void>) {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((target: PendingRemoval) => {
    setError(null);
    setPending(target);
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
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setRemovingName(null);
    }
  }, [pending, fetchIntegrations]);

  return { pending, removingName, error, request, cancel, confirm } as const;
}
