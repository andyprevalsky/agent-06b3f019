/**
 * Config for the whats-app-qr-modal feature: constants for the QR render
 * (size, error-correction level) and copy shown in the modal header /
 * instructions block.
 */

// qrcode.react — pixel dimensions of the rendered <svg>. The blackbox
// contract selects the QR by `width="200"`, so any change to this value
// must be mirrored in the test (or the selector generalised).
export const QR_CODE_SIZE = 200;

// qrcode.react error-correction level. "M" = ~15% recovery, matches
// WhatsApp's own QR pairing UI density.
export const QR_CODE_LEVEL = 'M' as const;
export const QR_CODE_INCLUDE_MARGIN = false;

// Header copy
export const MODAL_TITLE = 'Connect WhatsApp';
export const MODAL_DESCRIPTION = 'Scan this QR code with WhatsApp on your phone to connect.';
export const INSTRUCTIONS_HEADING = 'How to scan:';
export const CONNECTING_LABEL = 'Connecting...';
