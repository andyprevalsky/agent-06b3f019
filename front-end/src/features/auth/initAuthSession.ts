import type { Session } from '@supabase/supabase-js';
import {
  getSession,
  createAnonymousSession,
  waitForElectronAuthBridgePrimed,
} from '@/lib/supabase';

import { sendOTP, verifyOTP } from './api';
import { DEV_AUTO_LOGIN_OTP, DEV_AUTO_LOGIN_PHONE, IS_DEV_AUTO_LOGIN } from './config';

/** Module-level logger for the auth feature. */
export function logAuth(message: string, payload?: Record<string, unknown>): void {
  console.warn(`[Auth] ${message}`, payload ?? '');
}

/** Initial auth resolution: restore existing session, dev auto-login, or create anonymous session. */
export async function initAuthSession(
  applySession: (origin: string, nextSession: Session | null) => Promise<void>,
): Promise<void> {
  logAuth('Initializing auth state...');
  await waitForElectronAuthBridgePrimed();
  const existingSession = getSession();

  if (existingSession && !existingSession.user?.is_anonymous) {
    logAuth('Found non-anonymous session', { userId: existingSession.user?.id });
    await applySession('init', existingSession);
    return;
  }

  if (IS_DEV_AUTO_LOGIN) {
    logAuth('Dev mode: auto-logging in with test credentials...');
    try {
      await sendOTP(DEV_AUTO_LOGIN_PHONE);
      const { session: devSession } = await verifyOTP(DEV_AUTO_LOGIN_PHONE, DEV_AUTO_LOGIN_OTP);
      await applySession('dev-auto-login', devSession);
      logAuth('Dev auto-login complete', { userId: devSession.user.id });
      return;
    } catch (error) {
      console.error('[Auth] Dev auto-login failed, falling back to anonymous:', error);
    }
  } else if (existingSession) {
    logAuth('Found session', {
      userId: existingSession.user?.id,
      isAnonymous: existingSession.user?.is_anonymous,
    });
    await applySession('init', existingSession);
    return;
  }

  logAuth('No session found, creating anonymous session...');
  try {
    const { session: anonSession } = await createAnonymousSession();
    await applySession('init-anonymous', anonSession);
  } catch (error) {
    console.error('[Auth] Failed to create anonymous session:', error);
    // A concurrent login (another useAuth instance, dev auto-login) may have
    // produced a session while this attempt was in flight — never clobber it
    // with null; re-read storage instead.
    await applySession('init-anonymous-failed', getSession());
  }
}
