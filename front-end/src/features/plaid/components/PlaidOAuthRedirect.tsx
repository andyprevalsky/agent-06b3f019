/**
 * STATE MACHINE: PlaidOAuthRedirect
 *
 *   [MOUNTED, reads localStorage]
 *     |
 *     +--missing-token--> [ERROR_NO_TOKEN]   --button--> navigate('/')
 *     |
 *     +--has-token-------> [READY, calls usePlaidLink with receivedRedirectUri]
 *                              |
 *                              +--success-> [EXCHANGING] --done-> navigate('/')
 *                              |
 *                              +--exit/err-> [ERROR_LINK]   --button--> navigate('/')
 *
 * This component handles the redirect Plaid issues after OAuth-enabled US banks
 * (Chase, Wells, Cap One, US Bank, Citi) complete authentication on their own
 * domain. The original Link session is resumed by passing
 * `receivedRedirectUri = window.location.href` to `usePlaidLink`, which causes
 * the SDK to pick up where it left off rather than starting a new flow.
 *
 * Plaid docs: https://plaid.com/docs/link/oauth/
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { Loader2 } from 'lucide-react';

import { exchangePlaidPublicTokenApi } from '../api';
import { PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY } from '../config';

type State = 'reading_token' | 'ready' | 'exchanging' | 'done' | 'error_no_token' | 'error_link';

interface PlaidOAuthRedirectProps {
  /**
   * Where to navigate after a successful exchange. Default: '/' (back to the
   * Terminal / Integrations panel).
   */
  successHref?: string;
}

export default function PlaidOAuthRedirect({
  successHref = '/',
}: PlaidOAuthRedirectProps): JSX.Element {
  const [state, setState] = useState<State>('reading_token');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);

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
        try {
          window.localStorage.removeItem(PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY);
        } catch {
          // ignore
        }
        setState('done');
        window.location.replace(successHref);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to exchange Plaid token');
        setState('error_link');
      }
    },
    [successHref],
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {(state === 'reading_token' || state === 'ready' || state === 'exchanging') && (
          <>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {state === 'exchanging'
                ? 'Finishing connection…'
                : 'Resuming your bank connection…'}
            </p>
          </>
        )}
        {state === 'done' && (
          <p className="text-sm text-muted-foreground">Connection complete. Redirecting…</p>
        )}
        {state === 'error_no_token' && (
          <>
            <h1 className="text-lg font-semibold">Connection session not found</h1>
            <p className="text-sm text-muted-foreground">
              We couldn&apos;t find your Plaid session. Please return to Rose Labs and start the
              connection again.
            </p>
            <a
              href={successHref}
              className="inline-block mt-2 text-sm font-medium underline underline-offset-2"
            >
              Return to Rose Labs
            </a>
          </>
        )}
        {state === 'error_link' && (
          <>
            <h1 className="text-lg font-semibold">Connection failed</h1>
            {errorMessage !== null && errorMessage !== '' && (
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
            )}
            <a
              href={successHref}
              className="inline-block mt-2 text-sm font-medium underline underline-offset-2"
            >
              Return to Rose Labs
            </a>
          </>
        )}
      </div>
    </div>
  );
}
