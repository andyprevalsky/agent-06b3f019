import { useState, useCallback, useEffect, useRef } from 'react';

import {
  disconnectGmailAccountApi,
  fetchIntegrationsApi,
  resyncGmailAccountApi,
  startGmailOAuthApi,
} from '../api';
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

/**
 * Repair one damaged account.
 *
 * The server distinguishes a transient failure (which it retries inline) from a
 * revoked grant. Only the latter sends the user through OAuth, and it reuses the
 * normal connect flow rather than a second redirect path, so the Electron vs web
 * branch and the completion polling stay in one place.
 */
function useGmailResync(
  fetchIntegrations: () => Promise<void>,
  connect: (provider: 'gmail') => Promise<void>,
) {
  const [resyncingEmail, setResyncingEmail] = useState<string | null>(null);
  const handleEmailResync = useCallback(
    async (email: string) => {
      setResyncingEmail(email);
      try {
        const result = await resyncGmailAccountApi(email);
        if (result.needsReauth) {
          await connect('gmail');
          return;
        }
        await fetchIntegrations();
      } finally {
        setResyncingEmail(null);
      }
    },
    [fetchIntegrations, connect],
  );
  return { resyncingEmail, handleEmailResync } as const;
}

/**
 * Start the OAuth leg and, on desktop, wait for it to land.
 *
 * Web redirects the whole window, so there is nothing to wait for. Electron
 * opens the system browser instead, which never returns here -- hence the poll.
 * `oauthAttemptRef` invalidates any in-flight attempt when a newer one starts or
 * the component unmounts, so a stale poll can never resurrect the spinner.
 */
function useGmailOAuthConnect(fetchIntegrations: () => Promise<void>) {
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);
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

        if (electronApi === null) {
          window.location.href = payload.authUrl;
          return;
        }

        // Desktop: the OAuth leg happens in the system browser, so there is no
        // redirect back into this window -- poll until the account appears.
        await electronApi.openExternal(payload.authUrl);
        if (attempt !== oauthAttemptRef.current) return;

        const isStale = () => attempt !== oauthAttemptRef.current;
        const settle = () => {
          clearPolling();
          setConnectingProvider(null);
        };
        pollIntervalRef.current = setInterval(() => {
          void (async () => {
            try {
              const integrations = await fetchIntegrationsApi();
              if (isStale()) return;
              if (integrations.some((i) => i.name === provider)) {
                settle();
                void fetchIntegrations();
              }
            } catch {
              /* retry */
            }
          })();
        }, GMAIL_POLL_INTERVAL_MS);

        pollTimeoutRef.current = setTimeout(() => {
          if (isStale()) return;
          settle();
        }, GMAIL_POLL_TIMEOUT_MS);
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

  return { connectingProvider, handleEmailConnect } as const;
}

export function useGmailConnect(fetchIntegrations: () => Promise<void>) {
  const { connectingProvider, handleEmailConnect } = useGmailOAuthConnect(fetchIntegrations);
  const { disconnectingEmail, handleEmailDisconnect } = useGmailDisconnect(fetchIntegrations);
  const { resyncingEmail, handleEmailResync } = useGmailResync(
    fetchIntegrations,
    handleEmailConnect,
  );

  return {
    connectingProvider,
    disconnectingEmail,
    resyncingEmail,
    handleEmailConnect,
    handleEmailDisconnect,
    handleEmailResync,
  } as const;
}
