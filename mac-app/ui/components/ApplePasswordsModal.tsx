/**
 * Shim — the ApplePasswordsModal feature lives at
 * `ui/features/apple-passwords-modal/`.
 *
 * This re-export is retained because existing blackbox tests reference this
 * path directly (`import ApplePasswordsModal from '../../ui/components/ApplePasswordsModal'`).
 * Once those tests move to the new path this file can be deleted.
 */
export { default, default as ApplePasswordsModal } from '../features/apple-passwords-modal';
