import { useState, useCallback, useEffect, useRef } from 'react';

import { disconnectGmailAccountApi, fetchIntegrationsApi, startGmailOAuthApi } from '../api';
import { GMAIL_POLL_TIMEOUT_MS, GMAIL_POLL_INTERVAL_MS } from '../config';

interface ElectronExternalApi {
  openExternal: (url: string) => Promise<unknown>;
}

function electronExternalApi(): ElectronExternalApi | null {
  const candidate: unknown = window.api;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'openExternal' in candidate &&
    typeof candidate.openExternal === 'function'
  ) {
    return candidate as ElectronExternalApi;
  }
  return null;
}

export function useGmailConnect(fetchIntegrations: () => Promise<void>) {
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPolling = useCallback((): void => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearPolling, [clearPolling]);

  const handleEmailConnect = useCallback(
    async (provider: 'gmail') => {
      setConnectingProvider(provider);
      clearPolling();
      const electronApi = electronExternalApi();

      try {
        const returnUrl =
          electronApi !== null ? undefined : window.location.origin + window.location.pathname;
        const payload = await startGmailOAuthApi(returnUrl);

        if (electronApi !== null) {
          await electronApi.openExternal(payload.authUrl);

          pollIntervalRef.current = setInterval(() => {
            void (async () => {
              try {
                const integrations = await fetchIntegrationsApi();
                const gmail = integrations.find((i) => i.name === provider);
                if (gmail) {
                  clearPolling();
                  setConnectingProvider(null);
                  void fetchIntegrations();
                }
              } catch {
                /* retry */
              }
            })();
          }, GMAIL_POLL_INTERVAL_MS);

          pollTimeoutRef.current = setTimeout(() => {
            clearPolling();
            setConnectingProvider(null);
          }, GMAIL_POLL_TIMEOUT_MS);
        } else {
          window.location.href = payload.authUrl;
        }
      } catch (err) {
        clearPolling();
        setConnectingProvider(null);
        throw err;
      }
    },
    [clearPolling, fetchIntegrations],
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

  return {
    connectingProvider,
    disconnectingEmail,
    handleEmailConnect,
    handleEmailDisconnect,
  } as const;
}
