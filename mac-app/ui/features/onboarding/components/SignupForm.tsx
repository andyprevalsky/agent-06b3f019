import { ArrowRight } from 'lucide-react';
import PhoneInput from '@/features/auth/components/PhoneInput';
import { RoseLogo, ErrorBanner, fontFamily } from './OnboardingAuthShared';

const PHONE_FIELD_CLASS =
  'w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all';

const PHONE_TRIGGER_CLASS =
  'flex h-full items-center gap-1 px-2.5 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm';

interface SignupFormProps {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  loading: boolean;
  error: string | null;
  isFormValid: boolean;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const SignupForm = ({
  firstName,
  lastName,
  phone,
  email,
  loading,
  error,
  isFormValid,
  onFirstNameChange,
  onLastNameChange,
  onPhoneChange,
  onEmailChange,
  onSubmit,
}: SignupFormProps): JSX.Element => (
  <div className="flex-1 flex items-center justify-center px-8">
    <div className="w-full max-w-sm" style={{ fontFamily }}>
      <RoseLogo />
      <h1 className="text-2xl font-semibold text-foreground mt-4 mb-1">Rose</h1>
      <p className="text-muted-foreground mb-8" style={{ fontSize: '15px' }}>
        Sign up or log in to continue
      </p>
      <ErrorBanner error={error} />
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="text"
          placeholder="First name"
          value={firstName}
          onChange={(e) => onFirstNameChange(e.target.value)}
          required
          autoFocus
          className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
          disabled={loading}
        />
        <input
          type="text"
          placeholder="Last name"
          value={lastName}
          onChange={(e) => onLastNameChange(e.target.value)}
          required
          className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
          disabled={loading}
        />
        <PhoneInput
          value={phone}
          onChange={onPhoneChange}
          disabled={loading}
          inputClassName={PHONE_FIELD_CLASS}
          triggerClassName={PHONE_TRIGGER_CLASS}
        />
        <input
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-sm placeholder-muted-foreground/50 focus:outline-none focus:border-foreground/20 transition-all"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !isFormValid}
          className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? 'Sending code...' : 'Continue'}
          {loading ? null : <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      </form>
    </div>
  </div>
);
