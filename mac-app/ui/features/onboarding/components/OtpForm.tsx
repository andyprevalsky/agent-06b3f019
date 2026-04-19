import { ArrowRight } from 'lucide-react';
import { RoseLogo, ErrorBanner, fontFamily } from './OnboardingAuthShared';

interface OtpFormProps {
  phone: string;
  otp: string;
  smsAuthorized: boolean;
  loading: boolean;
  error: string | null;
  resendCountdown: number;
  onOtpChange: (value: string) => void;
  onSmsAuthorizedChange: (value: boolean) => void;
  onSubmit: (e: React.FormEvent) => void;
  onResend: () => void;
  onBackToSignup: () => void;
}

const SmsAuthLabel = ({
  smsAuthorized,
  onChange,
}: {
  smsAuthorized: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element => (
  <label className="flex items-start gap-3 p-3 bg-muted/30 border border-border rounded-xl cursor-pointer">
    <input
      type="checkbox"
      checked={smsAuthorized}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 w-4 h-4 rounded border-border text-foreground focus:ring-0 focus:ring-offset-0"
    />
    <div className="flex-1">
      <span className="text-sm font-medium text-foreground">I authorize SMS communication</span>
      <p className="text-xs text-muted-foreground mt-1">
        I authorize Rose Labs to send automated SMS messages to the phone number provided, including
        task updates, reminders, and status notifications. Message frequency varies. Message and
        data rates may apply. Text HELP for help or STOP to opt out. Consent is not a condition of
        purchase. See our{' '}
        <a
          href="https://roselabs.ai/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Privacy Policy
        </a>{' '}
        and{' '}
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
);

const OtpActions = ({
  loading,
  resendCountdown,
  onResend,
  onBackToSignup,
}: {
  loading: boolean;
  resendCountdown: number;
  onResend: () => void;
  onBackToSignup: () => void;
}): JSX.Element => (
  <div className="flex items-center justify-center gap-4 mt-4">
    <button
      type="button"
      onClick={onResend}
      disabled={loading || resendCountdown > 0}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
    </button>
    <span className="text-muted-foreground/30">|</span>
    <button
      type="button"
      onClick={onBackToSignup}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      Use a different number
    </button>
  </div>
);

export const OtpForm = ({
  phone,
  otp,
  smsAuthorized,
  loading,
  error,
  resendCountdown,
  onOtpChange,
  onSmsAuthorizedChange,
  onSubmit,
  onResend,
  onBackToSignup,
}: OtpFormProps): JSX.Element => (
  <div className="flex-1 flex items-center justify-center px-8">
    <div className="w-full max-w-sm" style={{ fontFamily }}>
      <RoseLogo />
      <h1 className="text-2xl font-semibold text-foreground mt-4 mb-1">Verify your number</h1>
      <p className="text-muted-foreground mb-8" style={{ fontSize: '15px' }}>
        We sent a code to {phone}
      </p>
      <ErrorBanner error={error} />
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder="000000"
          value={otp}
          onChange={(e) => onOtpChange(e.target.value.replace(/\D/g, ''))}
          required
          autoFocus
          className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-center text-sm font-mono tracking-widest placeholder-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
          disabled={loading}
        />
        <SmsAuthLabel smsAuthorized={smsAuthorized} onChange={onSmsAuthorizedChange} />
        <button
          type="submit"
          disabled={loading || otp.length !== 6 || !smsAuthorized}
          className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? 'Verifying...' : 'Continue'}
          {loading ? null : <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      </form>
      <OtpActions
        loading={loading}
        resendCountdown={resendCountdown}
        onResend={onResend}
        onBackToSignup={onBackToSignup}
      />
    </div>
  </div>
);
