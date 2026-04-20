/**
 * Public API barrel for the whats-app-qr-modal feature.
 *
 * Only `WhatsAppQRModal` crosses the feature boundary — it is the sole
 * consumer handle used by
 * `ui/features/onboarding/components/OnboardingData.tsx` (and the shim
 * at `ui/components/WhatsAppQRModal.tsx` kept for existing blackbox
 * tests). All other layer files (types, config, api, hooks,
 * components/*) are feature-internal.
 */

export { default } from './components/WhatsAppQRModal';
export { default as WhatsAppQRModal } from './components/WhatsAppQRModal';
