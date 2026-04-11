import { useState, useCallback } from 'react';

import { getAuthHeaders, startGmailOAuthApi } from '../api';
import { API_BASE_WITH_PATH, GMAIL_POLL_TIMEOUT_MS, GMAIL_POLL_INTERVAL_MS } from '../config';

export function useGmailConnect(fetchIntegrations: () => Promise<void>) {
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);

  const handleEmailConnect = useCallback(
    async (provider: 'gmail') => {
      setConnectingProvider(provider);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isElectron = !!(window as any).api;

      try {
        const returnUrl = isElectron
          ? undefined
          : window.location.origin + window.location.pathname;
        const payload = await startGmailOAuthApi(returnUrl);

        if (isElectron) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.openExternal(payload.authUrl);

          const headers = getAuthHeaders();
          const pollForConnection = setInterval(() => {
            void (async () => {
              try {
                const res = await fetch(`${API_BASE_WITH_PATH}/integrations`, { headers });
                if (!res.ok) return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const data: any = await res.json();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const gmail = (data.integrations || []).find((i: any) => i.name === provider);
                if (gmail) {
                  clearInterval(pollForConnection);
                  setConnectingProvider(null);
                  void fetchIntegrations();
                }
              } catch {
                /* retry */
              }
            })();
          }, GMAIL_POLL_INTERVAL_MS);

          setTimeout(() => {
            clearInterval(pollForConnection);
            setConnectingProvider(null);
          }, GMAIL_POLL_TIMEOUT_MS);
        } else {
          window.location.href = payload.authUrl;
        }
      } catch (err) {
        setConnectingProvider(null);
        throw err;
      }
    },
    [fetchIntegrations],
  );

  return { connectingProvider, handleEmailConnect } as const;
}
