/**
 * Barrel for the onboarding feature. External consumers (currently only
 * `ui/ElectronApp.tsx` via the `ui/onboarding/Onboarding.tsx` shim) should
 * import from here; everything else is an implementation detail.
 *
 * Forward-only imports within the feature: types → config → api → hooks →
 * components → barrel.
 */

export { default, default as Onboarding } from './components/Onboarding';
export { default as OnboardingAuth } from './components/OnboardingAuth';
export type { OnboardingStep } from './types';
