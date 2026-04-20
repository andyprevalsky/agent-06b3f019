import { X, Loader2, Key, ExternalLink, ShieldCheck } from 'lucide-react';
import keychainStep0 from '../../../assets/keychain-step0.png';
import keychainStep1 from '../../../assets/keychain-step1.png';
import keychainStep2 from '../../../assets/keychain-step2.png';
import { DEFAULT_SYNC_TYPE } from '../config';
import { useAtlasPasswordModal } from '../hooks';
import type { AtlasPasswordModalProps } from '../types';

interface KeychainStepProps {
  index: number;
  imageSrc: string;
  imageAlt: string;
  imageClassName: string;
  onExpand: (src: string) => void;
  children: React.ReactNode;
}

const KeychainStep = ({
  index,
  imageSrc,
  imageAlt,
  imageClassName,
  onExpand,
  children,
}: KeychainStepProps): JSX.Element => (
  <li className="space-y-2">
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
        {index}
      </span>
      {children}
    </div>
    <div className="flex justify-center">
      <button onClick={() => onExpand(imageSrc)} className="cursor-zoom-in">
        <img
          src={imageSrc}
          alt={imageAlt}
          className={`rounded-lg border border-border ${imageClassName}`}
        />
      </button>
    </div>
  </li>
);

interface HeaderProps {
  loading: boolean;
  onClose: () => void;
}

const Header = ({ loading, onClose }: HeaderProps): JSX.Element => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
    <div className="flex items-center gap-2">
      <Key className="w-4 h-4 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">Sync Atlas</h2>
    </div>
    <button
      type="button"
      onClick={onClose}
      disabled={loading}
      aria-label="Close"
      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);

interface StepsListProps {
  syncType: string;
  onOpenKeychain: () => void;
  onExpandImage: (src: string) => void;
}

const StepsList = ({ syncType, onOpenKeychain, onExpandImage }: StepsListProps): JSX.Element => (
  <>
    <p className="text-sm text-muted-foreground">
      Atlas (ChatGPT Desktop) uses a protected keychain. To sync your {syncType}:
    </p>
    <ol className="text-sm text-muted-foreground space-y-4">
      <KeychainStep
        index={1}
        imageSrc={keychainStep0}
        imageAlt="macOS dialog prompting to open Keychain Access"
        imageClassName="max-w-[250px]"
        onExpand={onExpandImage}
      >
        <div className="flex-1">
          <span>Click "Open Keychain Access" when prompted</span>
          <button
            onClick={onOpenKeychain}
            className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted hover:bg-muted/80 rounded transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Open Keychain
          </button>
        </div>
      </KeychainStep>
      <KeychainStep
        index={2}
        imageSrc={keychainStep1}
        imageAlt="Keychain Access showing ChatGPT Safe Storage"
        imageClassName="max-w-[450px]"
        onExpand={onExpandImage}
      >
        <span>Double-click "ChatGPT Safe Storage"</span>
      </KeychainStep>
      <KeychainStep
        index={3}
        imageSrc={keychainStep2}
        imageAlt="ChatGPT Safe Storage dialog with Show password checkbox"
        imageClassName="max-w-[400px]"
        onExpand={onExpandImage}
      >
        <span>Check "Show password" and enter your Mac password when prompted</span>
      </KeychainStep>
      <li className="flex items-start gap-3">
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
          4
        </span>
        <span>Copy the revealed password and paste it below</span>
      </li>
    </ol>
  </>
);

interface PasswordInputProps {
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

const PasswordInput = ({ value, loading, onChange, onSubmit }: PasswordInputProps): JSX.Element => (
  <div className="space-y-2">
    <label htmlFor="atlas-keychain-password" className="text-sm font-medium text-foreground">
      Keychain Password
    </label>
    <input
      id="atlas-keychain-password"
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Paste the password here..."
      disabled={loading}
      className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !loading) {
          onSubmit();
        }
      }}
    />
  </div>
);

interface SecurityNoticeProps {
  syncType: string;
}

const SecurityNotice = ({ syncType }: SecurityNoticeProps): JSX.Element => (
  <div className="flex items-start gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
    <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
    <p className="text-xs text-emerald-800 dark:text-emerald-200">
      <span className="font-medium">Your password never leaves your computer.</span> It's stored
      locally in Rose to keep your {syncType} in sync.
    </p>
  </div>
);

interface FooterProps {
  loading: boolean;
  password: string;
  onCancel: () => void;
  onSync: () => void;
}

const Footer = ({ loading, password, onCancel, onSync }: FooterProps): JSX.Element => (
  <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
    <button
      onClick={onCancel}
      disabled={loading}
      className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      Cancel
    </button>
    <button
      onClick={onSync}
      disabled={loading || password.trim() === ''}
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
);

interface LightboxProps {
  src: string | null;
  onClose: () => void;
}

const Lightbox = ({ src, onClose }: LightboxProps): JSX.Element | null => {
  if (src === null) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
    >
      <img src={src} alt="Expanded view" className="max-w-[90vw] max-h-[90vh] rounded-lg" />
    </div>
  );
};

/**
 * Modal for entering the Atlas (ChatGPT) keychain password.
 *
 * Atlas uses the Data Protection keychain which cannot be accessed
 * programmatically. Users must manually retrieve the password from
 * Keychain Access.
 */
const AtlasPasswordModal = ({
  isOpen,
  onClose,
  onSync,
  syncType = DEFAULT_SYNC_TYPE,
}: AtlasPasswordModalProps): JSX.Element | null => {
  const state = useAtlasPasswordModal({ onClose, onSync, syncType });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={state.handleClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <Header loading={state.loading} onClose={state.handleClose} />
        <div className="px-5 py-4 space-y-4">
          <StepsList
            syncType={syncType}
            onOpenKeychain={() => void state.handleOpenKeychain()}
            onExpandImage={state.setExpandedImage}
          />
          <PasswordInput
            value={state.password}
            loading={state.loading}
            onChange={state.setPassword}
            onSubmit={() => void state.handleSync()}
          />
          <SecurityNotice syncType={syncType} />
          {state.error !== null && <p className="text-sm text-red-500">{state.error}</p>}
        </div>
        <Footer
          loading={state.loading}
          password={state.password}
          onCancel={state.handleClose}
          onSync={() => void state.handleSync()}
        />
      </div>
      <Lightbox src={state.expandedImage} onClose={() => state.setExpandedImage(null)} />
    </div>
  );
};

export default AtlasPasswordModal;
