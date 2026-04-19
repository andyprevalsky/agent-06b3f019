/**
 * Shim — the onboarding feature lives at `ui/features/onboarding/`.
 *
 * This re-export is retained because the onboarding blackbox test imports
 * `../../ui/onboarding/OnboardingAuth` directly. Once the test moves to the
 * new feature path this file can be deleted.
 */
export { default } from '../features/onboarding/components/OnboardingAuth';
