/**
 * STATE MACHINE: usePlaidConnect
 *
 *   [IDLE] --connect()--> [FETCHING_LINK_TOKEN]
 *     |                       |
 *     |                       v
 *     |                   [LINK_OPEN]
 *     |                       |
 *     |                       +--success--> [EXCHANGING] --done--> [CONNECTED]
 *     |                       |                                       |
 *     |                       +--user-exit--> [IDLE]                  v
 *     |                       |                                    [IDLE]
 *     |                       +--error------> [ERROR]
 *     |
 *     +--disconnect(itemId)--> [DISCONNECTING] --done--> [IDLE]
 *
 * OAuth-bank flow (Chase, Wells, Cap One, US Bank, Citi):
 *
 *   [LINK_OPEN] --bank-redirect--> [OAUTH_PENDING] (link_token persisted)
 *     --window.location returns to /plaid-oauth-redirect-->
 *   [RESUMING_LINK] --bank-completes--> [EXCHANGING] --done--> [CONNECTED]
 */

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';

import {
  createPlaidLinkTokenApi,
  disconnectPlaidItemApi,
  exchangePlaidPublicTokenApi,
} from '../api';
import { PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY } from '../config';
import type { PlaidItem } from '../types';

type ConnectState =
  | 'idle'
  | 'fetching_link_token'
  | 'link_open'
  | 'exchanging'
  | 'disconnecting'
  | 'error';

interface UsePlaidConnectOptions {
  onConnected?: (item: PlaidItem) => void;
  onDisconnected?: (itemId: string) => void;
}

export function usePlaidConnect(options: UsePlaidConnectOptions = {}): {
  state: ConnectState;
  error: string | null;
  linkToken: string | null;
  connect: () => Promise<void>;
  disconnect: (itemId: string) => Promise<void>;
  ready: boolean;
} {
  const [state, setState] = useState<ConnectState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);

  const handleSuccess = useCallback(
    async (publicToken: string, metadata: PlaidLinkOnSuccessMetadata): Promise<void> => {
      setState('exchanging');
      try {
        const { item } = await exchangePlaidPublicTokenApi({
          publicToken,
          metadata: {
            institution: metadata.institution
              ? {
                  institution_id: metadata.institution.institution_id,
                  name: metadata.institution.name,
                }
              : null,
            accounts: metadata.accounts.map((a) => ({
              id: a.id,
              name: a.name,
              mask: a.mask,
              type: a.type,
              subtype: a.subtype,
            })),
            link_session_id: metadata.link_session_id,
          },
        });
        try {
          window.localStorage.removeItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY);
        } catch {
          // ignore storage errors
        }
        setState('idle');
        setLinkToken(null);
        options.onConnected?.(item);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to exchange Plaid token');
        setState('error');
      }
    },
    [options],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      void handleSuccess(publicToken, metadata);
    },
    onExit: (err) => {
      if (err) {
        setError(err.display_message ?? err.error_message ?? 'Plaid Link exited with error');
        setState('error');
      } else {
        setState('idle');
      }
      try {
        window.localStorage.removeItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
    },
  });

  useEffect(() => {
    if (linkToken !== null && ready && state === 'fetching_link_token') {
      setState('link_open');
      open();
    }
  }, [linkToken, ready, state, open]);

  const connect = useCallback(async (): Promise<void> => {
    setError(null);
    setState('fetching_link_token');
    try {
      const tokenResp = await createPlaidLinkTokenApi();
      setLinkToken(tokenResp.link_token);
      try {
        window.localStorage.setItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY, tokenResp.link_token);
      } catch {
        // ignore storage errors
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Plaid link token');
      setState('error');
    }
  }, []);

  const disconnect = useCallback(
    async (itemId: string): Promise<void> => {
      setState('disconnecting');
      setError(null);
      try {
        await disconnectPlaidItemApi(itemId);
        setState('idle');
        options.onDisconnected?.(itemId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to disconnect Plaid item');
        setState('error');
      }
    },
    [options],
  );

  return { state, error, linkToken, connect, disconnect, ready };
}
