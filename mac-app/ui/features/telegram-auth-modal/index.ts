/**
 * Public API barrel for the telegram-auth-modal feature.
 *
 * Only `TelegramAuthModal` crosses the feature boundary — it is the sole
 * consumer handle used by parent screens (and the shim at
 * `ui/components/TelegramAuthModal.tsx` kept for existing blackbox
 * tests). All other layer files (types, config, api, hooks, components/*)
 * are feature-internal.
 */

export { default } from './components/TelegramAuthModal';
export { default as TelegramAuthModal } from './components/TelegramAuthModal';
export type { TelegramAuthModalProps } from './types';
