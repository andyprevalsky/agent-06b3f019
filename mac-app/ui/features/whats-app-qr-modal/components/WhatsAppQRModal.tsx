/**
 * WhatsAppQRModal — shows a QR code the user scans in the WhatsApp app
 * to link this device to their account.
 *
 * State machine (prop-driven — no internal state):
 *   closed(isOpen=false)
 *        │ parent flips isOpen=true
 *        ▼
 *   open + pending(qrCode=null)         ──── spinner tile
 *        │ parent pushes QR via onWhatsAppQRCode IPC
 *        ▼
 *   open + ready(qrCode="wa://…")       ──── <svg> QR rendered
 *        │ user clicks backdrop / X, OR parent receives connect() success
 *        ▼
 *   onClose() → parent flips isOpen=false (and resets qrCode=null)
 *
 * All IPC wiring (`window.api.whatsapp.connect`,
 * `window.api.onWhatsAppQRCode`) lives in the parent
 * (`ui/features/onboarding/components/OnboardingData.tsx`) — this
 * component is a pure renderer over its props.
 */

import { Loader2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  CONNECTING_LABEL,
  INSTRUCTIONS_HEADING,
  MODAL_DESCRIPTION,
  MODAL_TITLE,
  QR_CODE_INCLUDE_MARGIN,
  QR_CODE_LEVEL,
  QR_CODE_SIZE,
} from '../config';
import type { WhatsAppQRModalProps } from '../types';
import WhatsAppIcon from './WhatsAppIcon';

const ModalHeader = ({ onClose }: { onClose: () => void }): React.ReactElement => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
    <div className="flex items-center gap-2">
      <WhatsAppIcon className="w-5 h-5" />
      <h2 className="text-base font-semibold text-foreground">{MODAL_TITLE}</h2>
    </div>
    <button
      onClick={onClose}
      className="text-muted-foreground hover:text-foreground transition-colors"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);

const QRTile = ({ qrCode }: { qrCode: string | null }): React.ReactElement => (
  <div className="flex justify-center">
    <div className="p-4 bg-white rounded-xl">
      {qrCode !== null ? (
        <QRCodeSVG
          value={qrCode}
          size={QR_CODE_SIZE}
          level={QR_CODE_LEVEL}
          includeMargin={QR_CODE_INCLUDE_MARGIN}
        />
      ) : (
        <div
          className="flex items-center justify-center"
          style={{ width: QR_CODE_SIZE, height: QR_CODE_SIZE }}
        >
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  </div>
);

const Instructions = (): React.ReactElement => (
  <div className="space-y-2 text-sm text-muted-foreground">
    <p className="font-medium text-foreground">{INSTRUCTIONS_HEADING}</p>
    <ol className="list-decimal list-inside space-y-1">
      <li>Open WhatsApp on your phone</li>
      <li>
        Tap <span className="font-medium">Settings</span> &gt;{' '}
        <span className="font-medium">Linked Devices</span>
      </li>
      <li>
        Tap <span className="font-medium">Link a Device</span>
      </li>
      <li>Point your phone at this screen to scan the code</li>
    </ol>
  </div>
);

const ConnectingIndicator = (): React.ReactElement => (
  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
    <Loader2 className="w-4 h-4 animate-spin" />
    <span>{CONNECTING_LABEL}</span>
  </div>
);

const WhatsAppQRModal = ({
  isOpen,
  onClose,
  qrCode,
  isConnecting,
}: WhatsAppQRModalProps): React.ReactElement | null => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <ModalHeader onClose={onClose} />

        <div className="px-5 py-6 space-y-4">
          <p className="text-sm text-muted-foreground text-center">{MODAL_DESCRIPTION}</p>

          <QRTile qrCode={qrCode} />
          <Instructions />

          {isConnecting && <ConnectingIndicator />}
        </div>
      </div>
    </div>
  );
};

export default WhatsAppQRModal;
