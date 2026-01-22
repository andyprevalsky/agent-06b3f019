import { useState } from 'react';
import { X, Loader2, Key, ExternalLink, ShieldCheck } from 'lucide-react';
import keychainStep0 from '../assets/keychain-step0.png';
import keychainStep1 from '../assets/keychain-step1.png';
import keychainStep2 from '../assets/keychain-step2.png';

interface AtlasPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: (password: string) => Promise<void>;
}

/**
 * Modal for entering the Atlas (ChatGPT) keychain password.
 *
 * Atlas uses the Data Protection keychain which cannot be accessed
 * programmatically. Users must manually retrieve the password from
 * Keychain Access.
 */
const AtlasPasswordModal = ({ isOpen, onClose, onSync }: AtlasPasswordModalProps) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleOpenKeychain = async () => {
    try {
      await window.api.openKeychainAccess('ChatGPT Safe Storage');
    } catch (err) {
      console.error('Failed to open Keychain Access:', err);
    }
  };

  const handleSync = async () => {
    if (!password.trim()) {
      setError('Please enter the keychain password');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onSync(password);
      // Success - modal will be closed by parent
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync cookies');
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setPassword('');
      setError(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">Sync Atlas Cookies</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Atlas (ChatGPT Desktop) uses a protected keychain. To sync your cookies:
          </p>

          <ol className="text-sm text-muted-foreground space-y-4">
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">1</span>
                <div className="flex-1">
                  <span>Click "Open Keychain Access" when prompted</span>
                  <button
                    onClick={handleOpenKeychain}
                    className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted hover:bg-muted/80 rounded transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open Keychain
                  </button>
                </div>
              </div>
              <div className="flex justify-center">
                <button onClick={() => setExpandedImage(keychainStep0)} className="cursor-zoom-in">
                  <img
                    src={keychainStep0}
                    alt="macOS dialog prompting to open Keychain Access"
                    className="rounded-lg border border-border max-w-[250px]"
                  />
                </button>
              </div>
            </li>
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">2</span>
                <span>Double-click "ChatGPT Safe Storage"</span>
              </div>
              <div className="flex justify-center">
                <button onClick={() => setExpandedImage(keychainStep1)} className="cursor-zoom-in">
                  <img
                    src={keychainStep1}
                    alt="Keychain Access showing ChatGPT Safe Storage"
                    className="rounded-lg border border-border max-w-[450px]"
                  />
                </button>
              </div>
            </li>
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">3</span>
                <span>Check "Show password" and enter your Mac password when prompted</span>
              </div>
              <div className="flex justify-center">
                <button onClick={() => setExpandedImage(keychainStep2)} className="cursor-zoom-in">
                  <img
                    src={keychainStep2}
                    alt="ChatGPT Safe Storage dialog with Show password checkbox"
                    className="rounded-lg border border-border max-w-[400px]"
                  />
                </button>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">4</span>
              <span>Copy the revealed password and paste it below</span>
            </li>
          </ol>

          {/* Password input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Keychain Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Paste the password here..."
              disabled={loading}
              className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading) {
                  handleSync();
                }
              }}
            />
          </div>

          {/* Security notice */}
          <div className="flex items-start gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-emerald-800 dark:text-emerald-200">
              <span className="font-medium">Your password never leaves your computer.</span>{' '}
              It's stored locally in Rose to keep your cookies in sync.
            </p>
          </div>

          {/* Error message */}
          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
          <button
            onClick={handleClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSync}
            disabled={loading || !password.trim()}
            className="px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Syncing...
              </>
            ) : (
              'Sync Cookies'
            )}
          </button>
        </div>
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded view"
            className="max-w-[90vw] max-h-[90vh] rounded-lg"
          />
        </div>
      )}
    </div>
  );
};

export default AtlasPasswordModal;
