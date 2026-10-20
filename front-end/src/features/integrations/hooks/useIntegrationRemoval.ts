/**
 * Remove-on-chip for accounts without a dedicated removal flow (Rose Desktop).
 *
 * STATE MACHINE
 *
 *   [IDLE] --chip × (request)--> [CONFIRMING(target)] --cancel--> [IDLE]
 *   [CONFIRMING] --confirm--> [REMOVING(target)] --DELETE ok--> refetch --> [IDLE]
 *                                                --DELETE fails--> [IDLE + error]
 *
 *   target.accountId set   → DELETE /api/integrations/:name/accounts/:accountId
 *   target.accountId unset → DELETE /api/integrations/:name (one-row providers)
 *
 * Gmail, Plaid and compute accounts keep their own existing removal flows. This
 * hook covers everything else, whose removal is new in the UI and hard to undo
 * (e.g. WhatsApp needs a fresh QR pairing), so it confirms first.
 */

import { useCallback, useState } from 'react';

import { deleteIntegrationAccountApi } from '../api';

export interface PendingRemoval {
  /** Integration row name, e.g. `chrome`, `chrome_passwords`, `imessage`. */
  name: string;
  /** Account within the row (multi-account backend); unset removes the whole row. */
  accountId?: string;
  /** What the user sees in the confirm dialog, e.g. "Chrome · Work". */
  label: string;
}

/** Stable identity of one removal target, used to show the chip's spinner. */
export function removalKey(name: string, accountId?: string): string {
  return accountId === undefined ? name : `${name}/${accountId}`;
}

export function useIntegrationRemoval(fetchIntegrations: () => Promise<void>) {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((target: PendingRemoval) => {
    setError(null);
    setPending(target);
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(async () => {
    if (pending === null) return;
    const { name, accountId } = pending;
    setPending(null);
    setRemovingKey(removalKey(name, accountId));
    try {
      await deleteIntegrationAccountApi(name, accountId);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove account');
    } finally {
      setRemovingKey(null);
    }
  }, [pending, fetchIntegrations]);

  return { pending, removingKey, error, request, cancel, confirm } as const;
}
