import { useState, useEffect, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { useToast } from '@/hooks/use-toast';
import * as analytics from '@/lib/analytics';
import {
  getSession,
  getCachedUser,
  isAnonymousUser,
  AUTH_SESSION_CHANGED_EVENT,
  waitForElectronAuthBridgePrimed,
} from '@/lib/supabase';
import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';

import { sendOTP, verifyOTP } from './api';
import { initAuthSession } from './hooks/initAuthSession';
import { useAuthFormState } from './hooks/useAuthFormState';
import { useAuthActions } from './hooks/useAuthActions';
import { useAuthStateLogging } from './hooks/useAuthStateLogging';

/** Extract a human-readable message from an unknown error value. */
function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

const BENCHMARK_ARCHIVE_USER = {
  id: 'benchmark-archive',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '1970-01-01T00:00:00.000Z',
} as User;

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

type AuthFormState = ReturnType<typeof useAuthFormState>;

function hasRequiredName(form: AuthFormState, collectName: boolean): boolean {
  return !collectName || (form.firstName.trim().length > 0 && form.lastName.trim().length > 0);
}

function buildUserInfo(form: AuthFormState, collectName: boolean) {
  return {
    email: form.email,
    firstName: collectName ? form.firstName.trim() : undefined,
    lastName: collectName ? form.lastName.trim() : undefined,
  };
}

function useAuthNavigation(form: AuthFormState, onOpenChange: (open: boolean) => void) {
  const handleBack = useCallback(() => {
    form.setStep('phone');
    form.setOtp('');
    form.setSmsAuthorized(false);
  }, [form]);
  const handleClose = useCallback(() => {
    form.resetForm();
    onOpenChange(false);
  }, [onOpenChange, form]);
  return { handleBack, handleClose };
}

/** Manages the full phone auth flow (phone -> OTP -> verified). */
export function usePhoneAuth(
  onOpenChange: (open: boolean) => void,
  onAuthComplete?: () => void,
  anonymousUserId?: string,
  collectName = false,
) {
  const { toast } = useToast();
  const form = useAuthFormState();
  const navigation = useAuthNavigation(form, onOpenChange);

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
      if (!hasRequiredName(form, collectName)) return;
      const requestGeneration = form.beginRequest();
      form.setLoading(true);
      try {
        // form.phone is canonical E.164 (PhoneInput owns normalization).
        await sendOTP(form.phone);
        if (!form.isRequestCurrent(requestGeneration)) return;
        analytics.track('phone_entered');
        form.setStep('otp');
        toast({ title: 'Code sent!', description: 'Check your phone for the 6-digit code.' });
      } catch (error: unknown) {
        if (form.isRequestCurrent(requestGeneration)) {
          toastError(toast, 'Error', error, 'Failed to send code. Please try again.');
        }
      } finally {
        if (form.isRequestCurrent(requestGeneration)) form.setLoading(false);
      }
    },
    [collectName, form, toast],
  );

  const handleVerifyOTP = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const requestGeneration = form.beginRequest();
      form.setLoading(true);
      try {
        await verifyOTP(form.phone, form.otp, anonymousUserId, buildUserInfo(form, collectName));
        if (!form.isRequestCurrent(requestGeneration)) return;
        analytics.track('otp_code_submitted');
        analytics.setUserId(form.phone);
        completeAuth();
      } catch (error: unknown) {
        if (form.isRequestCurrent(requestGeneration)) {
          toastError(toast, 'Invalid code', error, 'Please check the code and try again.');
          form.setLoading(false);
        }
      }
    },
    [form, anonymousUserId, collectName, completeAuth, toast],
  );

  return {
    step: form.step,
    phone: form.phone,
    setPhone: form.setPhone,
    email: form.email,
    setEmail: form.setEmail,
    firstName: form.firstName,
    setFirstName: form.setFirstName,
    lastName: form.lastName,
    setLastName: form.setLastName,
    otp: form.otp,
    setOtp: form.setOtp,
    loading: form.loading,
    smsAuthorized: form.smsAuthorized,
    setSmsAuthorized: form.setSmsAuthorized,
    handleSendOTP,
    handleVerifyOTP,
    ...navigation,
  } as const;
}

/**
 * Archive mode pins the hard-coded benchmark user, so the mutators returned
 * from useAuth must be inert there — a live refreshAuthState/signOut would
 * replace that user (with null or an anonymous session) while
 * isAuthenticated stays true.
 */
function useArchiveGuardedAuthActions(
  archiveMode: boolean,
  actions: Pick<ReturnType<typeof useAuthActions>, 'refreshAuthState' | 'signOut'>,
) {
  const { refreshAuthState, signOut } = actions;
  const guardedRefreshAuthState = useCallback(
    async (reason?: string) => {
      if (archiveMode) return;
      await refreshAuthState(reason);
    },
    [archiveMode, refreshAuthState],
  );
  const guardedSignOut = useCallback(async () => {
    if (archiveMode) return;
    await signOut();
  }, [archiveMode, signOut]);
  return { refreshAuthState: guardedRefreshAuthState, signOut: guardedSignOut };
}

/**
 * Auth state hook: session, user, loading, sign-out, invite-gate check.
 * SINGLE SOURCE OF TRUTH for realtime auth — setRealtimeAuth() is called here only.
 * `passive: true` observes auth without initiating sessions (no dev auto-login /
 * anonymous creation) — for components like WaitlistGate that only react to auth;
 * every extra initiating instance races the others and can clobber a login.
 */
export function useAuth(options?: { passive?: boolean }) {
  const passive = options?.passive === true;
  const archiveMode = isBenchmarkArchiveMode();
  const [user, setUser] = useState<User | null>(() =>
    archiveMode ? BENCHMARK_ARCHIVE_USER : getCachedUser(),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [isFullySignedIn, setIsFullySignedIn] = useState(archiveMode);
  // Unlike isFullySignedIn (false while the invite check is pending or failed),
  // true only when the check answered "needs invite": a known waitlisted account.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [loading, setLoading] = useState(!archiveMode);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const initRef = useRef(false);

  const isAuthenticated = archiveMode || !!session;
  const isAnonymous = isAnonymousUser(user);

  const { applySession, refreshAuthState, signOut } = useAuthActions({
    setUser,
    setSession,
    setIsFullySignedIn,
    setInviteRequired,
    setRealtimeReady,
  });
  const guardedActions = useArchiveGuardedAuthActions(archiveMode, { refreshAuthState, signOut });

  useEffect(() => {
    if (archiveMode) return;
    if (initRef.current) return;
    initRef.current = true;
    let mounted = true;
    const guardedApply = async (origin: string, sess: Session | null) => {
      if (mounted) await applySession(origin, sess);
    };
    const init = passive
      ? waitForElectronAuthBridgePrimed().then(() => guardedApply('passive-init', getSession()))
      : initAuthSession(guardedApply);
    void init.finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [applySession, archiveMode, passive]);

  useEffect(() => {
    if (archiveMode) return;
    const onAuthSessionChanged = () => {
      void refreshAuthState('session-storage-event');
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthSessionChanged);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onAuthSessionChanged);
    };
  }, [archiveMode, refreshAuthState]);

  useAuthStateLogging({ user, session, isAuthenticated, isAnonymous, isFullySignedIn, loading });

  return {
    user,
    session,
    isAuthenticated,
    isAnonymous,
    isFullySignedIn,
    inviteRequired,
    loading,
    realtimeReady,
    refreshAuthState: guardedActions.refreshAuthState,
    signOut: guardedActions.signOut,
  };
}
