/**
 * Inner shell that picks between Loading → Onboarding → Routes based on
 * auth + onboarding state. Thin: reads from hooks, renders JSX.
 *
 * State machine:
 *   authLoading || checkingOnboarding         → AppLoadingScreen
 *   FORCE_SHOW_ONBOARDING                     → Onboarding
 *   !isFullySignedIn                          → Onboarding (skipAuth = false)
 *   isFullySignedIn && !onboardingComplete    → Onboarding (skipAuth = true)
 *   isFullySignedIn && onboardingComplete     → AppRoutes
 */

import { useAuth } from '@/features/auth';
import Onboarding from '../../../onboarding/Onboarding';
import { FORCE_SHOW_ONBOARDING, FORCE_SKIP_AUTH } from '../config';
import { useOnboardingStatus } from '../hooks';
import type { AuthState } from '../types';
import AppLoadingScreen from './AppLoadingScreen';
import AppRoutes from './AppRoutes';

const ElectronAppInner = () => {
  const auth: AuthState = useAuth();
  const { isFullySignedIn, loading: authLoading } = auth;
  const { onboardingComplete, checkingOnboarding, handleOnboardingComplete } =
    useOnboardingStatus(auth);

  if (authLoading || checkingOnboarding) {
    return <AppLoadingScreen />;
  }

  const shouldShowOnboarding =
    FORCE_SHOW_ONBOARDING || !isFullySignedIn || onboardingComplete !== true;

  if (shouldShowOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          void handleOnboardingComplete();
        }}
        isSignedIn={isFullySignedIn}
        skipAuth={FORCE_SKIP_AUTH || (isFullySignedIn && onboardingComplete !== true)}
      />
    );
  }

  return <AppRoutes />;
};

export default ElectronAppInner;
