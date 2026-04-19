import { X, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

// WhatsApp icon component
const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24">
    <rect width="24" height="24" rx="5" fill="#25D366" />
    <path
      fill="white"
      d="M12 4c-4.42 0-8 3.58-8 8 0 1.41.37 2.73 1.01 3.88L4 20l4.26-1.12A7.93 7.93 0 0 0 12 20c4.42 0 8-3.58 8-8s-3.58-8-8-8zm4.14 11.07c-.17.48-1 .93-1.38.99-.37.06-.84.09-1.35-.09-.31-.11-.71-.25-1.23-.49-2.16-1-3.57-3.18-3.68-3.33-.1-.15-.86-1.14-.86-2.18s.55-1.55.74-1.76c.2-.21.43-.27.57-.27h.42c.13 0 .31-.05.48.37.18.43.61 1.49.66 1.59.05.1.08.22.02.35-.07.14-.1.22-.2.34-.1.12-.21.26-.3.35-.1.1-.2.2-.09.4.12.2.53.87 1.13 1.41.78.7 1.43.91 1.63 1.02.2.1.32.09.44-.06.12-.14.5-.58.64-.78.13-.2.27-.16.45-.1.18.07 1.15.54 1.34.64.2.1.33.15.38.23.05.09.05.51-.12.99z"
    />
  </svg>
);

interface WhatsAppQRModalProps {
  isOpen: boolean;
  onClose: () => void;
  qrCode: string | null;
  isConnecting: boolean;
}

const WhatsAppQRModal = ({ isOpen, onClose, qrCode, isConnecting }: WhatsAppQRModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <WhatsAppIcon className="w-5 h-5" />
            <h2 className="text-base font-semibold text-foreground">Connect WhatsApp</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-6 space-y-4">
          <p className="text-sm text-muted-foreground text-center">
            Scan this QR code with WhatsApp on your phone to connect.
          </p>

          {/* QR Code Container */}
          <div className="flex justify-center">
            <div className="p-4 bg-white rounded-xl">
              {qrCode ? (
                <QRCodeSVG value={qrCode} size={200} level="M" includeMargin={false} />
              ) : (
                <div className="w-[200px] h-[200px] flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">How to scan:</p>
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

          {isConnecting && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Connecting...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WhatsAppQRModal;
