import { useState } from 'react';
import { supabase, sendOTP, verifyOTP, signOut } from '@/lib/supabase';
import { Check, LogOut } from 'lucide-react';

type AuthMethod = 'google' | 'apple' | 'phone' | 'email';
type AuthStep = 'choose' | 'phone-input' | 'phone-otp' | 'email-input' | 'success';

interface AuthSectionProps {
  onAuthSuccess: () => void;
  onLogout?: () => void;
}

const AuthSection = ({ onAuthSuccess, onLogout }: AuthSectionProps) => {
  const [step, setStep] = useState<AuthStep>('choose');
  const [loading, setLoading] = useState<AuthMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod | null>(null);
  const [userIdentifier, setUserIdentifier] = useState<string>('');

  // Phone auth state
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');

  // Email auth state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(true);

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

  const completeAuth = (method: AuthMethod, identifier: string) => {
    setAuthMethod(method);
    setUserIdentifier(identifier);
    setStep('success');
    onAuthSuccess();
  };

  const handleLogout = async () => {
    try {
      await signOut();
      // Reset all state
      setStep('choose');
      setAuthMethod(null);
      setUserIdentifier('');
      setPhone('');
      setOtp('');
      setEmail('');
      setPassword('');
      setError(null);
      // Notify parent component
      onLogout?.();
    } catch (err: any) {
      setError(err.message || 'Failed to sign out');
    }
  };

  const handleGoogleAuth = async () => {
    setLoading('google');
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      // For Electron, we need to handle the OAuth URL
      // The OAuth flow will redirect back to the app
      completeAuth('google', 'Google Account');
    } catch (err: any) {
      setError(err.message || 'Failed to sign in with Google');
    } finally {
      setLoading(null);
    }
  };

  const handleAppleAuth = async () => {
    setLoading('apple');
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
          redirectTo: window.location.origin,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;
      completeAuth('apple', 'Apple Account');
    } catch (err: any) {
      setError(err.message || 'Failed to sign in with Apple');
    } finally {
      setLoading(null);
    }
  };

  const handlePhoneSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading('phone');
    setError(null);

    try {
      const strippedPhone = stripPhoneNumber(phone);
      await sendOTP(strippedPhone);
      setStep('phone-otp');
    } catch (err: any) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(null);
    }
  };

  const handlePhoneVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading('phone');
    setError(null);

    try {
      const strippedPhone = stripPhoneNumber(phone);
      await verifyOTP(strippedPhone, otp);
      completeAuth('phone', phone);
    } catch (err: any) {
      setError(err.message || 'Invalid verification code');
    } finally {
      setLoading(null);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading('email');
    setError(null);

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
      completeAuth('email', email);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(null);
    }
  };

  const handleBack = () => {
    setStep('choose');
    setError(null);
    setPhone('');
    setOtp('');
    setEmail('');
    setPassword('');
  };

  // Auth method selection
  if (step === 'choose') {
    return (
      <div className="space-y-3">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Google Sign In */}
        <button
          onClick={handleGoogleAuth}
          disabled={loading !== null}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-card border border-border hover:border-primary/20 hover:shadow-md transition-all duration-200 disabled:opacity-50"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          <span className="text-sm font-medium text-foreground">
            {loading === 'google' ? 'Connecting...' : 'Continue with Google'}
          </span>
        </button>

        {/* Apple Sign In */}
        <button
          onClick={handleAppleAuth}
          disabled={loading !== null}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-card border border-border hover:border-primary/20 hover:shadow-md transition-all duration-200 disabled:opacity-50"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
          </svg>
          <span className="text-sm font-medium text-foreground">
            {loading === 'apple' ? 'Connecting...' : 'Continue with Apple'}
          </span>
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Phone Auth */}
        <button
          onClick={() => setStep('phone-input')}
          disabled={loading !== null}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-card border border-border hover:border-primary/20 hover:shadow-md transition-all duration-200 disabled:opacity-50"
        >
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
          </svg>
          <span className="text-sm font-medium text-foreground">
            Continue with Phone
          </span>
        </button>

        {/* Email Auth */}
        <button
          onClick={() => setStep('email-input')}
          disabled={loading !== null}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-card border border-border hover:border-primary/20 hover:shadow-md transition-all duration-200 disabled:opacity-50"
        >
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
          <span className="text-sm font-medium text-foreground">
            Continue with Email
          </span>
        </button>
      </div>
    );
  }

  // Phone input step
  if (step === 'phone-input') {
    return (
      <form onSubmit={handlePhoneSendOTP} className="space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="phone" className="block text-sm text-muted-foreground mb-1.5">
            Phone Number
          </label>
          <input
            id="phone"
            type="tel"
            placeholder="+1 (555)-123-4567"
            value={phone}
            onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
            required
            autoFocus
            className="w-full px-4 py-3 bg-card border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10 transition-all"
            disabled={loading !== null}
          />
        </div>

        <button
          type="submit"
          disabled={loading !== null || !phone}
          className="w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading === 'phone' ? 'Sending code...' : 'Send verification code'}
        </button>

        <button
          type="button"
          onClick={handleBack}
          className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to options
        </button>
      </form>
    );
  }

  // Phone OTP step
  if (step === 'phone-otp') {
    return (
      <form onSubmit={handlePhoneVerifyOTP} className="space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div className="text-center mb-2">
          <p className="text-sm text-muted-foreground">
            Code sent to <span className="text-foreground font-medium">{phone}</span>
          </p>
        </div>

        <div>
          <label htmlFor="otp" className="block text-sm text-muted-foreground mb-1.5">
            Verification Code
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            required
            autoFocus
            className="w-full px-4 py-3 bg-card border border-border rounded-xl text-foreground text-center text-lg font-mono tracking-[0.5em] placeholder-muted-foreground/50 focus:outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10 transition-all"
            disabled={loading !== null}
          />
        </div>

        <button
          type="submit"
          disabled={loading !== null || otp.length !== 6}
          className="w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading === 'phone' ? 'Verifying...' : 'Verify code'}
        </button>

        <button
          type="button"
          onClick={handleBack}
          className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to options
        </button>
      </form>
    );
  }

  // Email input step
  if (step === 'email-input') {
    return (
      <form onSubmit={handleEmailAuth} className="space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm text-muted-foreground mb-1.5">
            Email
          </label>
          <input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="w-full px-4 py-3 bg-card border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10 transition-all"
            disabled={loading !== null}
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm text-muted-foreground mb-1.5">
            Password
          </label>
          <input
            id="password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-4 py-3 bg-card border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10 transition-all"
            disabled={loading !== null}
          />
        </div>

        <button
          type="submit"
          disabled={loading !== null || !email || !password}
          className="w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading === 'email'
            ? isSignUp ? 'Creating account...' : 'Signing in...'
            : isSignUp ? 'Create account' : 'Sign in'
          }
        </button>

        <button
          type="button"
          onClick={() => setIsSignUp(!isSignUp)}
          className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>

        <button
          type="button"
          onClick={handleBack}
          className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to options
        </button>
      </form>
    );
  }

  // Success state - show green checkmark with change account option
  if (step === 'success') {
    const getMethodIcon = () => {
      switch (authMethod) {
        case 'google':
          return (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
          );
        case 'apple':
          return (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
          );
        case 'phone':
          return (
            <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
            </svg>
          );
        case 'email':
          return (
            <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          );
        default:
          return null;
      }
    };

    return (
      <div className="space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Success card */}
        <div className="p-4 rounded-xl bg-green-50 border border-green-200 flex items-center gap-4">
          {/* Green checkmark */}
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
            <Check className="w-6 h-6 text-green-600" strokeWidth={2.5} />
          </div>

          {/* Account info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {getMethodIcon()}
              <span className="text-sm font-medium text-green-800">
                Account connected
              </span>
            </div>
            <p className="text-sm text-green-700 truncate">
              {userIdentifier}
            </p>
          </div>
        </div>

        {/* Change account button */}
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-card border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/20 transition-all"
        >
          <LogOut className="w-4 h-4" />
          Change account
        </button>
      </div>
    );
  }

  return null;
};

export default AuthSection;
