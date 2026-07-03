import { useState, useCallback } from 'react';

import { disconnectGmailAccountApi, fetchIntegrationsApi, startGmailOAuthApi } from '../api';
import { GMAIL_POLL_TIMEOUT_MS, GMAIL_POLL_INTERVAL_MS } from '../config';

export function useGmailConnect(fetchIntegrations: () => Promise<void>) {
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);

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

          const pollForConnection = setInterval(() => {
            void (async () => {
              try {
                const integrations = await fetchIntegrationsApi();
                const gmail = integrations.find((i) => i.name === provider);
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

  const handleEmailDisconnect = useCallback(
    async (email: string) => {
      setDisconnectingEmail(email);
      try {
        await disconnectGmailAccountApi(email);
        await fetchIntegrations();
      } finally {
        setDisconnectingEmail(null);
      }
    },
    [fetchIntegrations],
  );

  return { connectingProvider, disconnectingEmail, handleEmailConnect, handleEmailDisconnect } as const;
}
