/**
 * STATE MACHINE: stable connector entry point
 * [LOADING] → [SIGNED OUT / ANONYMOUS] --Sign in to Rose--> [PHONE AUTH]
 * [PHONE AUTH] --existing OTP completes--> [AUTH / INVITE CHECK]
 * [SIGNED IN] → shared Integrations provider chooser with normalized search.
 * Provider OAuth starts only through the existing Connect action.
 * AppProviders retains its global WaitlistGate; this route never bypasses it.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PhoneAuthModal, useAuth } from '@/features/auth';
import { Integrations } from '@/features/integrations';
import { Button } from '@/components/ui/button';

export default function ConnectIntegration() {
  const { provider } = useParams<{ provider: string }>();
  const [loginOpen, setLoginOpen] = useState(false);
  const { user, isAnonymous, loading, isFullySignedIn, refreshAuthState } = useAuth();
  const initialSearch = (provider ?? '').replace(/[_-]+/g, ' ').toLowerCase().trim();
  const signedOut = user === null || isAnonymous;
  return (
    <>
      {loading ? (
        <p role="status" className="p-6 text-center">
          Loading integrations…
        </p>
      ) : signedOut ? (
        <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-xl font-semibold">Connect your integrations</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to Rose to choose and connect your apps.
          </p>
          <Button onClick={() => setLoginOpen(true)}>Sign in to Rose</Button>
        </div>
      ) : isFullySignedIn ? (
        <Integrations key={provider} initialSearch={initialSearch} />
      ) : (
        <p role="status" className="p-6 text-center">
          Checking your Rose access…
        </p>
      )}
      <PhoneAuthModal
        open={loginOpen}
        onOpenChange={setLoginOpen}
        anonymousUserId={isAnonymous ? user?.id : undefined}
        onAuthComplete={() => {
          void refreshAuthState('connector-login-complete');
        }}
      />
    </>
  );
}
