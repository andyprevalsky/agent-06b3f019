/**
 * WhatsApp accounts on the Rose Desktop list (plan row I2): one chip per linked phone.
 *
 * STATE MACHINE
 *
 *   [IDLE] --addAccount()--> [ADDING] --paired--> refetch list --> [IDLE]
 *                                     --failed / canceled--> [IDLE + error]
 *     pairing: the shell's handler.addAccount (it shows the QR) → else the Mac
 *     bridge's window.api.whatsapp.addAccount → else handler.connect (old shells)
 *   removal: logoutFor(phone) runs before the backend DELETE —
 *     Mac bridge present → handler.logout ?? window.api.whatsapp.logout(phone)
 *     web (no bridge) or the legacy `default` account → no logout, DELETE only
 *
 * System context:
 *   DesktopIntegrations → this hook → IntegrationHandlers.whatsApp / window.api.whatsapp
 *     → Baileys socket per phone (mac-app messaging-whatsapp)
 *   chip × → useIntegrationRemoval (prepare = logoutFor) → DELETE
 *     /api/integrations/whatsapp/accounts/<encodeURIComponent(phone)>
 */

import { useCallback, useRef, useState } from 'react';

import { useIntegrationHandlers } from '@/features/integration-handlers-context';

type BridgeResult = { success: boolean; error?: string };

/** A linked phone's account id is its E.164 number; `default` is the legacy row. */
const E164 = /^\+\d{5,20}$/;

const PAIR_FAILED = 'WhatsApp pairing failed. Please try again.';

function macBridge() {
  return typeof window === 'undefined' ? undefined : window.api?.whatsapp;
}

export function useWhatsAppAccounts(fetchIntegrations: () => Promise<void>) {
  const handler = useIntegrationHandlers().whatsApp;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const addAccount = useCallback(async () => {
    const pair: (() => Promise<BridgeResult>) | undefined =
      handler?.addAccount ?? macBridge()?.addAccount ?? handler?.connect;
    if (pair === undefined || inFlight.current) return;
    inFlight.current = true;
    setAdding(true);
    setError(null);
    try {
      const result = await pair();
      if (!result.success) throw new Error(result.error ?? PAIR_FAILED);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : PAIR_FAILED);
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  }, [handler, fetchIntegrations]);

  /** The Mac logout to run before deleting `accountId`, or undefined when none applies. */
  const logoutFor = useCallback(
    (accountId: string): (() => Promise<void>) | undefined => {
      const bridge = macBridge();
      if (bridge === undefined || !E164.test(accountId)) return undefined;
      const logout = handler?.logout ?? ((phone: string) => bridge.logout(phone));
      return async () => {
        const result = await logout(accountId);
        if (!result.success) {
          throw new Error(result.error ?? `Could not log ${accountId} out of WhatsApp on this Mac`);
        }
      };
    },
    [handler],
  );

  return { addAccount, adding, error, logoutFor } as const;
}
