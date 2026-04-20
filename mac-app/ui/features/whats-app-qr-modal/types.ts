/**
 * Types for the whats-app-qr-modal feature.
 *
 * Props cross the feature boundary (parent passes the open flag, the
 * latest QR payload streamed in over IPC, and a close callback). This
 * modal has no local state — it is a pure prop-driven renderer.
 */

export interface WhatsAppQRModalProps {
  isOpen: boolean;
  onClose: () => void;
  qrCode: string | null;
  isConnecting: boolean;
}
