/**
 * STATE MACHINE: Waitlist Entry Page
 *
 * [AUTH_LOADING] -- auth resolved signed-out/anonymous --> [LOGIN_OPEN]
 *       |                                                  |
 *       | auth resolved signed-in                          +-- close --> [LOGIN_DISMISSED]
 *       v                                                  +-- OTP success --> [SIGNED_IN]
 * [SIGNED_IN] ----------------------------------------------------------+
 *       |
 *       +-- global WaitlistGate checks invite status
 *             +-- invite required --> waitlist confirmation
 *             +-- invite redeemed --> main Terminal remains available
 */

import { useCallback, useState } from 'react';

import { PhoneAuthModal, useAuth } from '@/features/auth';
import Terminal from '@/features/terminal';

const Waitlist = () => {
  const [loginDismissed, setLoginDismissed] = useState(false);
  const { user, isAnonymous, loading, refreshAuthState } = useAuth({ passive: true });
  const loginOpen = !loading && !loginDismissed && (user === null || isAnonymous);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setLoginDismissed(true);
  }, []);

  const handleAuthComplete = useCallback(() => {
    void refreshAuthState('waitlist-login-complete').catch((error: unknown) => {
      console.error('[Waitlist] Failed to refresh auth state after OTP verify', error);
    });
  }, [refreshAuthState]);

  return (
    <>
      <Terminal />
      <PhoneAuthModal
        open={loginOpen}
        onOpenChange={handleOpenChange}
        onAuthComplete={handleAuthComplete}
        anonymousUserId={isAnonymous ? user?.id : undefined}
        title="Join the Waitlist"
      />
    </>
  );
};

export default Waitlist;
