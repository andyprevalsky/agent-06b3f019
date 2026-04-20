/**
 * Shim — the WhatsAppQRModal feature lives at
 * `ui/features/whats-app-qr-modal/`.
 *
 * This re-export is retained because existing blackbox tests reference
 * this path directly
 * (`import WhatsAppQRModal from '../../ui/components/WhatsAppQRModal'`).
 * Once those tests move to the new path this file can be deleted.
 */
export { default, default as WhatsAppQRModal } from '../features/whats-app-qr-modal';
