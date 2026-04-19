/**
 * Shim — the AtlasPasswordModal feature lives at
 * `ui/features/atlas-password-modal/`.
 *
 * This re-export is retained because existing blackbox tests reference
 * this path directly
 * (`import AtlasPasswordModal from '../../ui/components/AtlasPasswordModal'`).
 * Once those tests move to the new path this file can be deleted.
 */
export { default } from '../features/atlas-password-modal';
export { default as AtlasPasswordModal } from '../features/atlas-password-modal';
