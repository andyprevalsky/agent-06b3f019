/**
 * IPC wrappers for the whats-app-qr-modal feature.
 *
 * This modal is a pure presentational component — all IPC wiring
 * (`window.api.whatsapp.connect` + `window.api.onWhatsAppQRCode`) lives
 * in the parent (`ui/features/onboarding/components/OnboardingData.tsx`).
 * From the modal's perspective, the "IPC update" surface is the `qrCode`
 * prop, which the parent refreshes as new QR payloads arrive.
 *
 * This file is intentionally empty aside from this contract so the
 * feature retains the canonical layer shape (types / config / api /
 * hooks / components / index).
 */

export {};
