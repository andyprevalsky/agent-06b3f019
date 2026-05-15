/**
 * STATE MACHINE: PlaidOAuthRedirect
 *
 *   [MOUNTED, reads localStorage]
 *     |
 *     +--missing-token--> [ERROR_NO_TOKEN]   --button--> navigate('/')
 *     |
 *     +--has-token-------> [READY, usePlaidLink with receivedRedirectUri]
 *                              |
 *                              +--success-> [EXCHANGING] --done-> navigate('/')
 *                              |
 *                              +--exit/err-> [ERROR_LINK]   --button--> navigate('/')
 *
 * See `usePlaidOAuthResume` for the orchestration logic; this component only
 * renders the state-machine output.
 */

import { useCallback } from 'react';
import { Loader2 } from 'lucide-react';

import { usePlaidOAuthResume } from '../hooks/usePlaidOAuthResume';

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
  const onComplete = useCallback(() => {
    window.location.replace(successHref);
  }, [successHref]);

  const { state, errorMessage } = usePlaidOAuthResume(onComplete);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {(state === 'reading_token' || state === 'ready' || state === 'exchanging') && (
          <>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {state === 'exchanging' ? 'Finishing connection…' : 'Resuming your bank connection…'}
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
