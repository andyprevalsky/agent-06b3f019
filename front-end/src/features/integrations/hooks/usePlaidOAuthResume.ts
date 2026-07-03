/**
 * STATE MACHINE: usePlaidOAuthResume
 *
 *   [READING_TOKEN]
 *     --no-token--> [ERROR_NO_TOKEN]
 *     --has-token--> [READY]
 *       --link-success--> [EXCHANGING]
 *         --create flow: exchange public token--> [DONE] (caller navigates away)
 *         --update flow: complete update mode--> [DONE] (caller navigates away)
 *         --error--> [ERROR_LINK]
 *       --link-exit/error--> [ERROR_LINK]
 *
 * Resumes a Plaid Link session after OAuth-enabled US banks (Chase, Wells, Cap
 * One, US Bank, Citi) complete authentication on their own domain. The
 * original Link session is resumed by passing `receivedRedirectUri =
 * window.location.href` to `usePlaidLink`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';

import { completePlaidUpdateModeApi, exchangePlaidPublicTokenApi } from '../api';
import { PLAID_OAUTH_CONTEXT_STORAGE_KEY, PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY } from '../config';

export type PlaidOAuthResumeState =
  | 'reading_token'
  | 'ready'
  | 'exchanging'
  | 'done'
  | 'error_no_token'
  | 'error_link';

type PlaidOAuthContext =
  | { mode: 'create' }
  | {
      mode: 'update';
      itemId: string;
    };

function readPlaidOAuthContext(): PlaidOAuthContext {
  const raw = window.localStorage.getItem(PLAID_OAUTH_CONTEXT_STORAGE_KEY);
  if (raw === null || raw === '') return { mode: 'create' };
  const parsed = JSON.parse(raw) as Partial<PlaidOAuthContext>;
  if (parsed.mode === 'update' && 'itemId' in parsed && typeof parsed.itemId === 'string') {
    return { mode: 'update', itemId: parsed.itemId };
  }
  return { mode: 'create' };
}

function clearPlaidOAuthContext(): void {
  window.localStorage.removeItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(PLAID_OAUTH_CONTEXT_STORAGE_KEY);
}

export function usePlaidOAuthResume(onComplete: () => void): {
  state: PlaidOAuthResumeState;
  errorMessage: string | null;
} {
  const [state, setState] = useState<PlaidOAuthResumeState>('reading_token');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [oauthContext, setOauthContext] = useState<PlaidOAuthContext>({ mode: 'create' });

  const receivedRedirectUri = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return window.location.href;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY);
      if (stored === null || stored === '') {
        setState('error_no_token');
        return;
      }
      setOauthContext(readPlaidOAuthContext());
      setLinkToken(stored);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'localStorage read failed');
      setState('error_no_token');
    }
  }, []);

  const handleSuccess = useCallback(
    async (publicToken: string, metadata: PlaidLinkOnSuccessMetadata): Promise<void> => {
      setState('exchanging');
      try {
        if (oauthContext.mode === 'update') {
          await completePlaidUpdateModeApi(oauthContext.itemId);
        } else {
          await exchangePlaidPublicTokenApi({
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
        }
        clearPlaidOAuthContext();
        setState('done');
        onComplete();
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to exchange Plaid token');
        setState('error_link');
      }
    },
    [onComplete, oauthContext],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri,
    onSuccess: (publicToken, metadata) => {
      void handleSuccess(publicToken, metadata);
    },
    onExit: (err) => {
      if (err) {
        setErrorMessage(err.display_message ?? err.error_message ?? 'Plaid Link exited');
        setState('error_link');
      } else {
        setState('error_link');
        setErrorMessage('Plaid Link was closed before authentication completed.');
      }
    },
  });

  useEffect(() => {
    if (state === 'ready' && ready) {
      open();
    }
  }, [state, ready, open]);

  return { state, errorMessage };
}
