import { Loader2, X } from 'lucide-react';
import { useTelegramAuthModal } from '../hooks';
import type { TelegramAuthModalProps, UseTelegramAuthModalResult } from '../types';
import { PhoneStep } from './PhoneStep';
import { CodeStep } from './CodeStep';
import { PasswordStep } from './PasswordStep';
import { TelegramIcon } from './TelegramIcon';

/**
 * Pure renderer for the Telegram phone → code → password auth flow.
 *
 * All state and IPC orchestration live in `useTelegramAuthModal`; this file
 * is just JSX + user-event wiring. Behavior contract is documented in the
 * hook.
 */

interface HeaderProps {
  loading: boolean;
  onClose: () => void;
}

const Header = ({ loading, onClose }: HeaderProps): JSX.Element => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
    <div className="flex items-center gap-2">
      <TelegramIcon className="w-5 h-5" />
      <h2 className="text-base font-semibold text-foreground">Connect Telegram</h2>
    </div>
    <button
      onClick={onClose}
      disabled={loading}
      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);

interface FooterProps {
  loading: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
}

const Footer = ({ loading, submitLabel, onCancel, onSubmit }: FooterProps): JSX.Element => (
  <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
    <button
      onClick={onCancel}
      disabled={loading}
      className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      Cancel
    </button>
    <button
      onClick={onSubmit}
      disabled={loading}
      className="px-4 py-2 text-sm font-medium bg-[#229ED9] text-white rounded-lg hover:bg-[#229ED9]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
    >
      {loading ? (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          Processing...
        </>
      ) : (
        submitLabel
      )}
    </button>
  </div>
);

const StepContent = ({ state }: { state: UseTelegramAuthModalResult }): JSX.Element | null => {
  switch (state.step) {
    case 'phone':
      return (
        <PhoneStep
          phoneNumber={state.phoneNumber}
          loading={state.loading}
          onChange={state.setPhoneNumber}
          onSubmit={state.handleSubmit}
        />
      );
    case 'code':
      return (
        <CodeStep
          phoneNumber={state.phoneNumber}
          code={state.code}
          loading={state.loading}
          onChange={state.setCode}
          onSubmit={state.handleSubmit}
          onBack={state.handleBackToPhone}
        />
      );
    case 'password':
      return (
        <PasswordStep
          password={state.password}
          loading={state.loading}
          onChange={state.setPassword}
          onSubmit={state.handleSubmit}
        />
      );
  }
};

const TelegramAuthModal = ({
  isOpen,
  onClose,
  onSuccess,
}: TelegramAuthModalProps): JSX.Element | null => {
  const state = useTelegramAuthModal(isOpen, onClose, onSuccess);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={state.handleClose} />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <Header loading={state.loading} onClose={state.handleClose} />

        {/* Content */}
        <div className="px-5 py-6 space-y-4">
          <StepContent state={state} />

          {/* Error message */}
          {state.error !== null && (
            <p className="text-sm text-red-500 text-center">{state.error}</p>
          )}
        </div>

        <Footer
          loading={state.loading}
          submitLabel={state.getSubmitLabel()}
          onCancel={state.handleClose}
          onSubmit={state.handleSubmit}
        />
      </div>
    </div>
  );
};

export default TelegramAuthModal;
