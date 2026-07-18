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

function useGmailDisconnect(fetchIntegrations: () => Promise<void>) {
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
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
  return { disconnectingEmail, handleEmailDisconnect } as const;
}

export function useGmailConnect(fetchIntegrations: () => Promise<void>) {
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);
  const { disconnectingEmail, handleEmailDisconnect } = useGmailDisconnect(fetchIntegrations);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthAttemptRef = useRef(0);

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

  useEffect(
    () => () => {
      oauthAttemptRef.current += 1;
      clearPolling();
    },
    [clearPolling],
  );

  const handleEmailConnect = useCallback(
    async (provider: 'gmail') => {
      const attempt = ++oauthAttemptRef.current;
      setConnectingProvider(provider);
      clearPolling();
      const electronApi = electronExternalApi();

      try {
        const returnUrl =
          electronApi !== null ? undefined : window.location.origin + window.location.pathname;
        const payload = await startGmailOAuthApi(returnUrl);
        if (attempt !== oauthAttemptRef.current) return;

        if (electronApi !== null) {
          await electronApi.openExternal(payload.authUrl);
          if (attempt !== oauthAttemptRef.current) return;

          pollIntervalRef.current = setInterval(() => {
            void (async () => {
              try {
                const integrations = await fetchIntegrationsApi();
                if (attempt !== oauthAttemptRef.current) return;
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
            if (attempt !== oauthAttemptRef.current) return;
            clearPolling();
            setConnectingProvider(null);
          }, GMAIL_POLL_TIMEOUT_MS);
        } else {
          window.location.href = payload.authUrl;
        }
      } catch (err) {
        if (attempt === oauthAttemptRef.current) {
          clearPolling();
          setConnectingProvider(null);
        }
        throw err;
      }
    },
    [clearPolling, fetchIntegrations],
  );

  return {
    connectingProvider,
    disconnectingEmail,
    handleEmailConnect,
    handleEmailDisconnect,
  } as const;
}
