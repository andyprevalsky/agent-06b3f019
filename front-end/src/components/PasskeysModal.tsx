/**
 * STATE MACHINE: PasskeysModal
 *
 * [CLOSED] --isOpen--> [READY]
 * [READY] --Sync--> [REQUESTING_PERMISSION] --not enabled--> [OPEN_SETTINGS]
 *   -> [WAITING_FOR_PERMISSION] --enabled--> [OPEN_PASSWORDS] --> [WAITING_FOR_IMPORT]
 * [READY] --Sync--> [REQUESTING_PERMISSION] --already enabled--> [OPEN_PASSWORDS] --> [WAITING_FOR_IMPORT]
 * [REQUESTING_PERMISSION|OPEN_PASSWORDS] --error--> [ERROR]
 * [WAITING_FOR_IMPORT] --parent importComplete--> [CLOSED]
 * [REQUESTING_PERMISSION|OPEN_PASSWORDS|WAITING_FOR_IMPORT] --X/Cancel--> [CLOSED, IMPORT_CONTINUES]
 * [REQUESTING_PERMISSION|OPEN_PASSWORDS|WAITING_FOR_IMPORT] --backdrop click--> stay open
 * [READY|ERROR] --click image--> [LIGHTBOX] --close--> [READY|ERROR]
 *
 * System context:
 *   Apple Passwords & Passkeys row -> this modal -> open AutoFill settings -> open Apple Passwords
 *     -> user exports to Rose -> macOS Credential Exchange token -> Rose importer -> backend sync
 */

import { useState, type CSSProperties } from 'react';
import { X, Loader2, KeyRound } from 'lucide-react';
import autofillSettingsImage from '@/assets/passkeys-autofill-settings.png';
import exportAllItemsImage from '@/assets/passkeys-export-all-items.png';

interface PasskeysModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: () => Promise<{
    enabled?: boolean;
    openedSettings?: boolean;
    openedPasswordsApp?: boolean;
  } | void>;
}

const EXPORT_ALL_ITEMS_HIGHLIGHT_STYLE: CSSProperties = {
  top: '21.3%',
  left: '16.1%',
  width: '34.6%',
  height: '4.3%',
};

function ExportAllItemsHighlight() {
  return (
    <div
      data-testid="passkeys-export-all-items-highlight"
      aria-hidden="true"
      className="absolute border-2 border-red-500 rounded pointer-events-none"
      style={EXPORT_ALL_ITEMS_HIGHLIGHT_STYLE}
    />
  );
}

const PasskeysModal = ({ isOpen, onClose, onSync }: PasskeysModalProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSync = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await onSync();
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync Apple Passwords and Passkeys');
      setLoading(false);
    }
  };
  const handleExplicitClose = () => {
    setError(null);
    onClose();
  };

  const handleBackdropClose = () => {
    if (loading) return;
    handleExplicitClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        data-testid="passkeys-modal-backdrop"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleBackdropClose}
      />

      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">
              Sync Apple Passwords &amp; Passkeys
            </h2>
          </div>
          <button
            type="button"
            onClick={handleExplicitClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Transfer credentials from Apple Passwords to Rose.
          </p>

          <ol className="text-sm text-muted-foreground space-y-4">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                1
              </span>
              <span>Click Sync to enable Rose for AutoFill and open Passwords.</span>
            </li>
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                  2
                </span>
                <span>Enable Rose under AutoFill from.</span>
              </div>
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setExpandedImage(autofillSettingsImage)}
                  className="cursor-zoom-in"
                >
                  <img
                    src={autofillSettingsImage}
                    alt="System Settings AutoFill and Passwords with the Rose row highlighted"
                    className="rounded-lg border border-border max-w-[450px]"
                  />
                </button>
              </div>
            </li>
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                  3
                </span>
                <span>Choose File &gt; Export All Items to App...</span>
              </div>
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setExpandedImage(exportAllItemsImage)}
                  className="relative cursor-zoom-in"
                >
                  <img
                    src={exportAllItemsImage}
                    alt="Passwords File menu with Export All Items to App highlighted"
                    className="rounded-lg border border-border max-w-[450px]"
                  />
                  <ExportAllItemsHighlight />
                </button>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                4
              </span>
              <span>Pick Rose, confirm, and keep Rose open until the row becomes a checkmark.</span>
            </li>
          </ol>

          {error !== null && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
          <button
            type="button"
            onClick={handleExplicitClose}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Syncing...
              </>
            ) : (
              'Sync'
            )}
          </button>
        </div>
      </div>

      {expandedImage !== null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setExpandedImage(null)}
        >
          <div className="relative">
            <img
              src={expandedImage}
              alt="Expanded view"
              className="max-w-[90vw] max-h-[90vh] rounded-lg"
            />
            {expandedImage === exportAllItemsImage && <ExportAllItemsHighlight />}
          </div>
        </div>
      )}
    </div>
  );
};

export default PasskeysModal;
