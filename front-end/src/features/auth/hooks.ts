import { useState, useEffect, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { useToast } from '@/hooks/use-toast';
import * as analytics from '@/lib/analytics';
import {
  getSession,
  clearSession,
  getCachedUser,
  persistCachedUser,
  createAnonymousSession,
  isAnonymousUser,
  setRealtimeAuth,
  AUTH_SESSION_CHANGED_EVENT,
  waitForElectronAuthBridgePrimed,
} from '@/lib/supabase';
import { checkNeedsInviteCode } from '@/lib/api';

import { sendOTP, verifyOTP } from './api';
import { DEV_AUTO_LOGIN_OTP, DEV_AUTO_LOGIN_PHONE, IS_DEV_AUTO_LOGIN } from './config';
import type { AuthStep } from './types';

/** Strips a formatted phone number to E.164: +19729777432. */
function stripPhoneNumber(formatted: string): string {
  return '+' + formatted.replace(/\D/g, '');
}

/** Module-level logger for the auth feature. */
function logAuth(message: string, payload?: Record<string, unknown>): void {
  console.warn(`[Auth] ${message}`, payload ?? '');
}

/** Initial auth resolution: restore existing session, dev auto-login, or create anonymous session. */
async function initAuthSession(
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
    await applySession('init-anonymous-failed', null);
  }
}

/** Extract a human-readable message from an unknown error value. */
function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Show an error toast from an unknown thrown value. */
function toastError(
  toast: ReturnType<typeof useToast>['toast'],
  title: string,
  error: unknown,
  fallback: string,
) {
  console.error(title, error);
  toast({ title, description: getErrorMessage(error, fallback), variant: 'destructive' });
}

/** Internal form state for the phone auth flow. */
function useAuthFormState() {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [smsAuthorized, setSmsAuthorized] = useState(false);
  const resetForm = useCallback(() => {
    setStep('phone');
    setPhone('');
    setOtp('');
    setSmsAuthorized(false);
  }, []);
  return {
    step,
    setStep,
    phone,
    setPhone,
    otp,
    setOtp,
    loading,
    setLoading,
    smsAuthorized,
    setSmsAuthorized,
    resetForm,
  };
}

/** Manages the full phone auth flow (phone -> OTP -> verified). */
export function usePhoneAuth(
  onOpenChange: (open: boolean) => void,
  onAuthComplete?: () => void,
  anonymousUserId?: string,
) {
  const { toast } = useToast();
  const form = useAuthFormState();

  const completeAuth = useCallback(() => {
    toast({ title: 'Success!', description: "You're now logged in." });
    form.setLoading(false);
    onOpenChange(false);
    form.resetForm();
    onAuthComplete?.();
  }, [onOpenChange, onAuthComplete, toast, form]);

  const handleSendOTP = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      form.setLoading(true);
      try {
        await sendOTP(stripPhoneNumber(form.phone));
        analytics.track('phone_entered');
        form.setStep('otp');
        toast({ title: 'Code sent!', description: 'Check your phone for the 6-digit code.' });
      } catch (error: unknown) {
        toastError(toast, 'Error', error, 'Failed to send code. Please try again.');
      } finally {
        form.setLoading(false);
      }
    },
    [form, toast],
  );

  const handleVerifyOTP = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      form.setLoading(true);
      try {
        const strippedPhone = stripPhoneNumber(form.phone);
        await verifyOTP(strippedPhone, form.otp, anonymousUserId);
        analytics.track('otp_code_submitted');
        analytics.setUserId(strippedPhone);
        completeAuth();
      } catch (error: unknown) {
        toastError(toast, 'Invalid code', error, 'Please check the code and try again.');
        form.setLoading(false);
      }
    },
    [form, anonymousUserId, completeAuth, toast],
  );

  return {
    step: form.step,
    phone: form.phone,
    setPhone: form.setPhone,
    otp: form.otp,
    setOtp: form.setOtp,
    loading: form.loading,
    smsAuthorized: form.smsAuthorized,
    setSmsAuthorized: form.setSmsAuthorized,
    handleSendOTP,
    handleVerifyOTP,
    handleBack: useCallback(() => {
      form.setStep('phone');
      form.setOtp('');
      form.setSmsAuthorized(false);
    }, [form]),
    handleClose: useCallback(() => {
      onOpenChange(false);
      setTimeout(form.resetForm, 200);
    }, [onOpenChange, form]),
  } as const;
}

interface AuthStateSetters {
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  setIsFullySignedIn: React.Dispatch<React.SetStateAction<boolean>>;
  setRealtimeReady: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Memoized auth actions: updateInviteStatus, applySession, refreshAuthState, signOut. */
function useAuthActions(setters: AuthStateSetters) {
  const { setUser, setSession, setIsFullySignedIn, setRealtimeReady } = setters;

  const updateInviteStatus = useCallback(
    async (currentSession: Session | null, currentUser: User | null) => {
      if (!currentSession || isAnonymousUser(currentUser)) {
        setIsFullySignedIn(false);
        return;
      }
      try {
        const needsInvite = await checkNeedsInviteCode();
        setIsFullySignedIn(!needsInvite);
        logAuth('Invite check result', { needsInvite, isFullySignedIn: !needsInvite });
      } catch (error) {
        console.error('[Auth] Failed to check invite requirement', error);
        setIsFullySignedIn(false);
      }
    },
    [setIsFullySignedIn],
  );

  const applySession = useCallback(
    async (origin: string, nextSession: Session | null) => {
      logAuth(`Applying session (${origin})`, {
        hasSession: !!nextSession,
        isAnonymous: nextSession?.user?.is_anonymous,
      });
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      persistCachedUser(nextSession?.user ?? null);
      await setRealtimeAuth(nextSession?.access_token ?? null);
      setRealtimeReady(!!nextSession?.access_token);
      await updateInviteStatus(nextSession, nextSession?.user ?? null);
    },
    [setSession, setUser, setRealtimeReady, updateInviteStatus],
  );

  const refreshAuthState = useCallback(
    async (reason = 'manual-refresh') => {
      logAuth(`refreshAuthState (${reason})`);
      await applySession(reason, getSession());
    },
    [applySession],
  );

  const signOut = useCallback(async () => {
    logAuth('Signing out');
    await clearSession();
    setSession(null);
    setUser(null);
    persistCachedUser(null);
    setIsFullySignedIn(false);
    setRealtimeReady(false);
    await setRealtimeAuth(null);
    try {
      const { session: anonSession } = await createAnonymousSession();
      await applySession('post-signout-anonymous', anonSession);
    } catch (error) {
      console.error('[Auth] Failed to create anonymous session after signout:', error);
    }
  }, [applySession, setSession, setUser, setIsFullySignedIn, setRealtimeReady]);

  return { applySession, refreshAuthState, signOut };
}

/**
 * Auth state hook: session, user, loading, sign-out, invite-gate check.
 * SINGLE SOURCE OF TRUTH for realtime auth — setRealtimeAuth() is called here only.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [session, setSession] = useState<Session | null>(null);
  const [isFullySignedIn, setIsFullySignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const initRef = useRef(false);

  const isAuthenticated = !!session;
  const isAnonymous = isAnonymousUser(user);

  const { applySession, refreshAuthState, signOut } = useAuthActions({
    setUser,
    setSession,
    setIsFullySignedIn,
    setRealtimeReady,
  });

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    let mounted = true;
    const guardedApply = async (origin: string, sess: Session | null) => {
      if (mounted) await applySession(origin, sess);
    };
    void initAuthSession(guardedApply).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [applySession]);

  useEffect(() => {
    const onAuthSessionChanged = () => {
      void refreshAuthState('session-storage-event');
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthSessionChanged);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthSessionChanged);
    };
  }, [refreshAuthState]);

  useEffect(() => {
    logAuth('State changed', {
      userId: user?.id,
      hasSession: !!session,
      isAuthenticated,
      isAnonymous,
      isFullySignedIn,
      loading,
    });
  }, [user, session, isAuthenticated, isAnonymous, isFullySignedIn, loading]);

  return {
    user,
    session,
    isAuthenticated,
    isAnonymous,
    isFullySignedIn,
    loading,
    realtimeReady,
    refreshAuthState,
    signOut,
  };
}
