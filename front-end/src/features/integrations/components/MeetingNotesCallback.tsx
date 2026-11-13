/**
 * STATE MACHINE: MeetingNotesCallback (route /integrations/:provider/callback)
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
 * The provider redirects the browser here. Finishing requires the Rose session of
 * the user who started the sign-in, so a sign-in link sent to someone else can
 * never attach their provider account to the sender's Rose account.
 */

import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useMeetingNotesCallback } from '../hooks/useMeetingNotesCallback';
import { meetingNotesProviders } from '../config';
import type { MeetingNotesProvider } from '../types';

export default function MeetingNotesCallback({
  provider,
}: {
  provider: MeetingNotesProvider;
}): JSX.Element {
  const { name } = meetingNotesProviders[provider];
  const { state, message } = useMeetingNotesCallback(provider);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {state === 'completing' && (
          <>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Connecting {name}…</p>
          </>
        )}
        {state === 'done' && (
          <p className="text-sm text-muted-foreground">{name} connected. Redirecting…</p>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-lg font-semibold">Couldn&apos;t connect {name}</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button onClick={() => window.location.replace('/')}>Back to Rose</Button>
          </>
        )}
      </div>
    </div>
  );
}
