/**
 * Business logic hooks for the electron-app shell.
 *
 * Hooks layer: orchestrates api.ts + React state. No JSX, no direct fetch,
 * no direct window.api.* calls — route all IO through ./api.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  fetchOnboardingComplete,
  markOnboardingCompleteOnBackend,
  syncElectronOnboardingComplete,
} from './api';
import type { AuthSnapshot, AuthState } from './types';

/**
 * Pure orchestrator extracted from the original useEffect body. Kept as a
 * named function so the logic is straightforward to reason about and unit-
 * test. Callers pass in setters so the hook can stay presentation-agnostic.
 */
const resolveOnboardingState = async (
  auth: AuthSnapshot,
  setOnboardingComplete: (v: boolean) => void,
  setCheckingOnboarding: (v: boolean) => void
): Promise<void> => {
  console.log('[ElectronApp] checkOnboarding called', auth);
  if (auth.authLoading) return;
  if (!auth.isFullySignedIn) {
    console.log('[ElectronApp] Not fully signed in, showing onboarding');
    setOnboardingComplete(false);
    setCheckingOnboarding(false);
    return;
  }
  try {
    const complete = await fetchOnboardingComplete();
    setOnboardingComplete(complete === true);
    if (complete === true) await syncElectronOnboardingComplete();
  } catch (err) {
    console.error('[ElectronApp] Failed to check onboarding status:', err);
    setOnboardingComplete(false);
  } finally {
    setCheckingOnboarding(false);
  }
};

interface OnboardingStatus {
  /** `null` while the status is still being resolved. */
  onboardingComplete: boolean | null;
  /** True while the backend probe is in-flight on this render cycle. */
  checkingOnboarding: boolean;
  /** Run the "user finished onboarding" finalizer — updates backend, electron store, auth state. */
  handleOnboardingComplete: () => Promise<void>;
}

/**
 * Orchestrates onboarding-status resolution against the user's auth state.
 *
 * Re-checks whenever `authLoading` or `isFullySignedIn` changes (matches the
 * original dep list — `isAnonymous` is logged but does not trigger a re-run).
 * Exposes `handleOnboardingComplete` to flip the flag after the Onboarding
 * flow finishes, which also refreshes the auth context so the shell can
 * transition straight into the Terminal view.
 */
export const useOnboardingStatus = (auth: AuthState): OnboardingStatus => {
  const { loading: authLoading, isFullySignedIn, isAnonymous, refreshAuthState } = auth;

  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  useEffect(() => {
    void resolveOnboardingState(
      { authLoading, isFullySignedIn, isAnonymous },
      setOnboardingComplete,
      setCheckingOnboarding
    );
    // Mirror original deps: isAnonymous is logged only, not a re-run trigger.
  }, [authLoading, isFullySignedIn]);

  const handleOnboardingComplete = useCallback(async (): Promise<void> => {
    console.log('[ElectronApp] handleOnboardingComplete called');
    try {
      await markOnboardingCompleteOnBackend();
    } catch (err) {
      console.error('[ElectronApp] Failed to complete onboarding on backend:', err);
    }

    // Sync local electron store and enable global shortcuts now that onboarding is done
    console.log('[ElectronApp] Syncing local electron store...');
    await syncElectronOnboardingComplete();
    // Refresh auth state so isFullySignedIn picks up the session from onboarding
    await refreshAuthState('onboarding-complete');

    setOnboardingComplete(true);
    console.log('[ElectronApp] Onboarding complete, rendering Terminal');
  }, [refreshAuthState]);

  return { onboardingComplete, checkingOnboarding, handleOnboardingComplete };
};
