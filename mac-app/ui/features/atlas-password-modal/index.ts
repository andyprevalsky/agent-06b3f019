/**
 * Public API barrel for the atlas-password-modal feature.
 *
 * Only `AtlasPasswordModal` crosses the feature boundary — it is the sole
 * consumer handle used by parent screens (and the shim at
 * `ui/components/AtlasPasswordModal.tsx` kept for existing blackbox
 * tests). All other layer files (types, config, api, hooks,
 * components/*) are feature-internal.
 */

export { default } from './components/AtlasPasswordModal';
export { default as AtlasPasswordModal } from './components/AtlasPasswordModal';
export type { AtlasPasswordModalProps, AtlasPasswordSyncType } from './types';
