/**
 * Public API barrel for the apple-passwords-modal feature.
 *
 * Only `ApplePasswordsModal` crosses the feature boundary — it is the sole
 * consumer handle used by `ui/onboarding/OnboardingData.tsx` (and the shim
 * at `ui/components/ApplePasswordsModal.tsx` kept for existing blackbox
 * tests). All other layer files (types, config, api, hooks, components/*)
 * are feature-internal.
 */

export { default } from './components/ApplePasswordsModal';
export { default as ApplePasswordsModal } from './components/ApplePasswordsModal';
