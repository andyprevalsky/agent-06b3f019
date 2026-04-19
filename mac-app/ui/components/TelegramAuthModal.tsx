import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';

interface TelegramAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type AuthStep = 'phone' | 'code' | 'password';

// Telegram icon component
const TelegramIcon = ({ className = 'w-6 h-6' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24">
    <rect width="24" height="24" rx="5" fill="#229ED9" />
    <path
      fill="white"
      d="M5.5 11.5l10.7-4.3c.6-.24 1.1.12.9.92l-1.9 9c-.14.64-.52.8-1.06.5l-2.9-2.1-1.4 1.4c-.12.1-.2.2-.4.2-.26 0-.37-.15-.5-.52l-1.1-3.5-2.7-.84c-.32-.11-.34-.41.06-.56zm4.7 1.7l.6 2.55.17-1.85 4.5-4c.2-.18-.05-.27-.32-.1l-5.5 3.4z"
      transform="translate(12, 12) scale(1.05) translate(-12, -12)"
    />
  </svg>
);

// Format phone number as user types: +1 (XXX)-XXX-XXXX
const formatPhoneNumber = (value: string) => {
  const digits = value.replace(/\D/g, '');
  let formatted = '';

  if (digits.length === 0) return '';

  if (digits[0] === '1') {
    formatted = '+1';
    const remaining = digits.slice(1);
    if (remaining.length > 0) {
      formatted += ' (' + remaining.slice(0, 3);
      if (remaining.length >= 3) {
        formatted += ')';
        if (remaining.length > 3) {
          formatted += '-' + remaining.slice(3, 6);
          if (remaining.length > 6) {
            formatted += '-' + remaining.slice(6, 10);
          }
        }
      }
    }
  } else if (digits.length <= 10) {
    formatted = '+1 (' + digits.slice(0, 3);
    if (digits.length >= 3) {
      formatted += ')';
      if (digits.length > 3) {
        formatted += '-' + digits.slice(3, 6);
        if (digits.length > 6) {
          formatted += '-' + digits.slice(6, 10);
        }
      }
    }
  } else {
    formatted = '+' + digits;
  }

  return formatted;
};

const stripPhoneNumber = (formatted: string) => {
  return '+' + formatted.replace(/\D/g, '');
};

const TelegramAuthModal = ({ isOpen, onClose, onSuccess }: TelegramAuthModalProps) => {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set up event listeners for Telegram auth flow
  useEffect(() => {
    if (!isOpen) return;

    // Listen for auth events from main process
    window.api.onTelegramNeedCode?.(() => {
      console.log('[TelegramAuthModal] Received needCode event');
      setStep('code');
      setLoading(false);
    });

    window.api.onTelegramNeedPassword?.(() => {
      console.log('[TelegramAuthModal] Received needPassword event');
      setStep('password');
      setLoading(false);
    });

    window.api.onTelegramAuthComplete?.(() => {
      console.log('[TelegramAuthModal] Received authComplete event');
      setLoading(false);
      onSuccess();
      handleReset();
      onClose();
    });

    window.api.onTelegramAuthError?.((errorMessage: string) => {
      console.log('[TelegramAuthModal] Received authError event:', errorMessage);
      setError(errorMessage);
      setLoading(false);
    });
  }, [isOpen, onClose, onSuccess]);

  const handleReset = () => {
    setStep('phone');
    setPhoneNumber('');
    setCode('');
    setPassword('');
    setError(null);
    setLoading(false);
  };

  if (!isOpen) return null;

  const handleClose = () => {
    if (!loading) {
      // Cancel any ongoing auth
      window.api.telegram?.cancelAuth();
      handleReset();
      onClose();
    }
  };

  const handlePhoneSubmit = async () => {
    if (!phoneNumber.trim()) {
      setError('Please enter your phone number');
      return;
    }

    if (!window.api.telegram) {
      setError('Telegram API not available');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const phone = stripPhoneNumber(phoneNumber);
      console.log('[TelegramAuthModal] Starting auth for:', phone);

      const result = await window.api.telegram.startAuth(phone);

      if (!result.success) {
        setError(result.error || 'Failed to start authentication');
        setLoading(false);
      }
      // On success, we wait for the needCode event from main process
      // Loading stays true until we get the event
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
      setLoading(false);
    }
  };

  const handleCodeSubmit = async () => {
    if (!code.trim()) {
      setError('Please enter the verification code');
      return;
    }

    if (!window.api.telegram) {
      setError('Telegram API not available');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[TelegramAuthModal] Submitting code');
      await window.api.telegram.submitCode(code);
      // Wait for authComplete or needPassword event
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify code');
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async () => {
    if (!password.trim()) {
      setError('Please enter your 2FA password');
      return;
    }

    if (!window.api.telegram) {
      setError('Telegram API not available');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[TelegramAuthModal] Submitting password');
      await window.api.telegram.submitPassword(password);
      // Wait for authComplete event
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authenticate');
      setLoading(false);
    }
  };

  const renderStepContent = () => {
    switch (step) {
      case 'phone':
        return (
          <>
            <div className="flex justify-center mb-4">
              <TelegramIcon className="w-16 h-16" />
            </div>

            <p className="text-sm text-muted-foreground text-center mb-4">
              Enter your phone number to connect your Telegram account.
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Phone Number</label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(formatPhoneNumber(e.target.value))}
                placeholder="+1 (234)-567-8900"
                disabled={loading}
                className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) {
                    handlePhoneSubmit();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Include your country code (e.g., +1 for US)
              </p>
            </div>
          </>
        );

      case 'code':
        return (
          <>
            <p className="text-sm text-muted-foreground text-center mb-4">
              Telegram sent a code to{' '}
              <span className="font-medium text-foreground">{phoneNumber}</span>. Enter it below.
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Verification Code</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                disabled={loading}
                autoFocus
                className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50 tracking-widest text-center text-lg"
                maxLength={6}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) {
                    handleCodeSubmit();
                  }
                }}
              />
            </div>

            <button
              onClick={() => {
                window.api.telegram?.cancelAuth();
                setStep('phone');
                setCode('');
                setError(null);
              }}
              disabled={loading}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Wrong number? Go back
            </button>
          </>
        );

      case 'password':
        return (
          <>
            <p className="text-sm text-muted-foreground text-center mb-4">
              Your account has 2FA enabled. Enter your Telegram password.
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">2FA Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your 2FA password"
                disabled={loading}
                autoFocus
                className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) {
                    handlePasswordSubmit();
                  }
                }}
              />
            </div>
          </>
        );
    }
  };

  const handleSubmit = () => {
    switch (step) {
      case 'phone':
        handlePhoneSubmit();
        break;
      case 'code':
        handleCodeSubmit();
        break;
      case 'password':
        handlePasswordSubmit();
        break;
    }
  };

  const getSubmitLabel = () => {
    switch (step) {
      case 'phone':
        return 'Send Code';
      case 'code':
        return 'Verify';
      case 'password':
        return 'Sign In';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <TelegramIcon className="w-5 h-5" />
            <h2 className="text-base font-semibold text-foreground">Connect Telegram</h2>
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
        <div className="px-5 py-6 space-y-4">
          {renderStepContent()}

          {/* Error message */}
          {error && <p className="text-sm text-red-500 text-center">{error}</p>}
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
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-[#229ED9] text-white rounded-lg hover:bg-[#229ED9]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Processing...
              </>
            ) : (
              getSubmitLabel()
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TelegramAuthModal;
