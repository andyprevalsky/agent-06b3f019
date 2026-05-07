/**
 * Shim — the onboarding feature lives at `ui/features/onboarding/`.
 *
 * This re-export is retained because existing blackbox tests reference this
 * path directly (`vi.mock('../../ui/onboarding/Onboarding', ...)`). Vitest
 * resolves the mock target against a real module; once those tests move to the
 * new path this file can be deleted.
 */
export { default, Onboarding } from '../features/onboarding';
export type { OnboardingStep } from '../features/onboarding';
