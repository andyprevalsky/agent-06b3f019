import { useState, useEffect } from 'react';
import { sendOTP, verifyOTP } from '@/lib/supabase';
import { ArrowRight } from 'lucide-react';

type AuthStep = 'signup' | 'otp';

interface OnboardingAuthProps {
  onComplete: () => void;
}

// Rose logo component - matches Terminal header
const RoseLogo = () => (
  <div
    className="w-10 h-10 rounded-xl"
    style={{
      background:
        'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
    }}
  />
);

const OnboardingAuth = ({ onComplete }: OnboardingAuthProps) => {
  const [step, setStep] = useState<AuthStep>('signup');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [smsAuthorized, setSmsAuthorized] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);

  // Countdown timer for resend button
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

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

  // Check if phone is valid (at least 10 digits for US)
  const isPhoneValid = () => {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 11; // +1 + 10 digits
  };

  const isFormValid = () => {
    return firstName.trim() && lastName.trim() && isPhoneValid();
  };

  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid()) return;

    setLoading(true);
    setError(null);

    try {
      const strippedPhone = stripPhoneNumber(phone);
      await sendOTP(strippedPhone);
      setStep('otp');
      setResendCountdown(30);
    } catch (err: any) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOTP = async () => {
    if (resendCountdown > 0) return;

    setLoading(true);
    setError(null);

    try {
      const strippedPhone = stripPhoneNumber(phone);
      await sendOTP(strippedPhone);
      setResendCountdown(30);
    } catch (err: any) {
      setError(err.message || 'Failed to resend verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smsAuthorized) return;

    setLoading(true);
    setError(null);

    try {
      const strippedPhone = stripPhoneNumber(phone);
      await verifyOTP(strippedPhone, otp, undefined, { firstName, lastName });
      onComplete();
    } catch (err: any) {
      setError(err.message || 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  const fontFamily = 'Inter, system-ui, sans-serif';

  // Signup form (First Name, Last Name, Phone, Continue)
  if (step === 'signup') {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="w-full max-w-sm" style={{ fontFamily }}>
          {/* Logo */}
          <RoseLogo />

          {/* Title */}
          <h1 className="text-2xl font-semibold text-foreground mt-4 mb-1">
            Rose
          </h1>

          {/* Subtitle */}
          <p className="text-muted-foreground mb-8" style={{ fontSize: '15px' }}>
            Sign up or log in to continue
          </p>

          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">
              {error}
            </div>
          )}

          {/* Signup form */}
          <form onSubmit={handleSignupSubmit} className="space-y-3">
            <input
              type="text"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
              disabled={loading}
            />
            <input
              type="text"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
              disabled={loading}
            />
            <input
              type="tel"
              placeholder="Phone number"
              value={phone}
              onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
              required
              className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !isFormValid()}
              className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Sending code...' : 'Continue'}
              {!loading && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // OTP verification step
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="w-full max-w-sm" style={{ fontFamily }}>
        {/* Logo */}
        <RoseLogo />

        {/* Title */}
        <h1 className="text-2xl font-semibold text-foreground mt-4 mb-1">
          Verify your number
        </h1>

        {/* Subtitle */}
        <p className="text-muted-foreground mb-8" style={{ fontSize: '15px' }}>
          We sent a code to {phone}
        </p>

        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">
            {error}
          </div>
        )}

        {/* OTP input form */}
        <form onSubmit={handleOtpSubmit} className="space-y-3">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            required
            autoFocus
            className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-center text-sm font-mono tracking-widest placeholder-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
            disabled={loading}
          />

          {/* SMS Authorization checkbox */}
          <label className="flex items-start gap-3 p-3 bg-muted/30 border border-border rounded-xl cursor-pointer">
            <input
              type="checkbox"
              checked={smsAuthorized}
              onChange={(e) => setSmsAuthorized(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-border text-foreground focus:ring-0 focus:ring-offset-0"
            />
            <div className="flex-1">
              <span className="text-sm font-medium text-foreground">
                I authorize SMS communication
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                I authorize Rose Labs to send automated SMS messages to the phone number provided, including task updates, reminders, and status notifications. Message frequency varies. Message and data rates may apply. Text HELP for help or STOP to opt out. Consent is not a condition of purchase. See our{' '}
                <a
                  href="https://roselabs.ai/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Privacy Policy
                </a>
                {' '}and{' '}
                <a
                  href="https://roselabs.ai/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Terms of Service
                </a>
                .
              </p>
            </div>
          </label>

          <button
            type="submit"
            disabled={loading || otp.length !== 6 || !smsAuthorized}
            className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Verifying...' : 'Continue'}
            {!loading && <ArrowRight className="w-3.5 h-3.5" />}
          </button>
        </form>

        <div className="flex items-center justify-center gap-4 mt-4">
          <button
            type="button"
            onClick={handleResendOTP}
            disabled={loading || resendCountdown > 0}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
          </button>
          <span className="text-muted-foreground/30">|</span>
          <button
            type="button"
            onClick={() => {
              setStep('signup');
              setOtp('');
              setError(null);
              setResendCountdown(0);
            }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Use a different number
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingAuth;
