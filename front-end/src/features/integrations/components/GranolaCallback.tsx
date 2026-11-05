/**
 * STATE MACHINE: GranolaCallback (route /integrations/granola/callback)
 *
 *   [MOUNTED, reads ?code&state or ?error]
 *     |
 *     +--error / missing params--> [ERROR] --button--> navigate('/')
 *     |
 *     +--code+state-------------> [COMPLETING] (POST /oauth/complete with this
 *                                   user's own session)
 *                                     |
 *                                     +--ok--> [DONE] --> back to the page that
 *                                     |                   started sign-in
 *                                     +--refused / not signed in--> [ERROR]
 *
 * Granola redirects the browser here. Finishing requires the Rose session of
 * the user who started the sign-in, so a sign-in link sent to someone else can
 * never attach their Granola account to the sender's Rose account.
 */

import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useGranolaCallback } from '../hooks/useGranolaCallback';

export default function GranolaCallback(): JSX.Element {
  const { state, message } = useGranolaCallback();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {state === 'completing' && (
          <>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Connecting Granola…</p>
          </>
        )}
        {state === 'done' && (
          <p className="text-sm text-muted-foreground">Granola connected. Redirecting…</p>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-lg font-semibold">Couldn&apos;t connect Granola</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button onClick={() => window.location.replace('/')}>Back to Rose</Button>
          </>
        )}
      </div>
    </div>
  );
}
