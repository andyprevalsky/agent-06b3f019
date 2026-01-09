import { useState } from 'react';
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
    } catch (err: any) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
        <form onSubmit={handleOtpSubmit}>
          <div className="relative">
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
              className="w-full px-3 py-3 pr-10 bg-muted/30 border border-border rounded-xl text-foreground text-center text-sm font-mono tracking-widest placeholder-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>

        <button
          type="button"
          onClick={() => {
            setStep('signup');
            setOtp('');
            setError(null);
          }}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors mt-4"
        >
          Use a different number
        </button>
      </div>
    </div>
  );
};

export default OnboardingAuth;
