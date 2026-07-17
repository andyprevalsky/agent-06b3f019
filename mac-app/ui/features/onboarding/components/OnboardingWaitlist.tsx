/**
 * STATE MACHINE: OnboardingWaitlist
 *
 *   [CHECKING] ──(needsInviteCode=false)──> onComplete()   // already in (code or subscription)
 *       │
 *       ├──(needsInviteCode=true & offWaitlist)──> [SUBSCRIBE]   // admin invited them off
 *       │
 *       └──(needsInviteCode=true & !offWaitlist | check failed)──> [WAITLIST]
 *
 *   [WAITLIST] / [SUBSCRIBE] ──(submit code)──> [SUBMITTING] ──(accepted)──> onComplete()
 *       ▲                              │
 *       └───────(rejected: inline error)──────┘
 *   [SUBSCRIBE] ──(Subscribe)──> opens Stripe checkout in the system browser
 *
 * Persistence: the gate lives server-side (User.usedInviteCode / offWaitlistAt /
 * active subscription via GET /api/invite-codes/check), so relaunching re-shows
 * the same terminal view until they subscribe or redeem a code.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getErrorMessageOrFallback } from '../../../../shared/utils/error';
import { useOnboardingWaitlistApi } from '../hooks';

const INVITE_CODE_LENGTH = 6;
const SUBSCRIBE_FALLBACK_URL = 'https://roselabs.ai/subscribe';

type WaitlistScreen = 'checking' | 'waitlist' | 'subscribe';

interface OnboardingWaitlistProps {
  onComplete: () => void;
}

/**
 * Open a URL in the system browser (Electron intercepts window.open). Falls back
 * to window.open if the Electron bridge is absent OR rejects, so checkout never
 * silently fails.
 */
const openExternal = async (url: string): Promise<void> => {
  const api = window.api as { openExternal?: (url: string) => Promise<void> } | undefined;
  if (api?.openExternal !== undefined) {
    try {
      await api.openExternal(url);
      return;
    } catch {
      // Bridge rejected — fall through to window.open below.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

interface InviteCodeFormProps {
  code: string;
  error: string | null;
  submitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCodeChange: (value: string) => void;
}

const InviteCodeForm = ({
  code,
  error,
  submitting,
  onSubmit,
  onCodeChange,
}: InviteCodeFormProps): JSX.Element => (
  <div className="space-y-6">
    <div className="flex items-center gap-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs text-muted-foreground">Have an invite code?</span>
      <div className="flex-1 h-px bg-border" />
    </div>

    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={INVITE_CODE_LENGTH}
        placeholder="000000"
        value={code}
        onChange={(e) => {
          onCodeChange(e.target.value.replace(/\D/g, ''));
        }}
        disabled={submitting}
        className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-center text-sm font-mono tracking-widest placeholder-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
      />
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      <button
        type="submit"
        disabled={submitting || code.length !== INVITE_CODE_LENGTH}
        className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? 'Checking...' : 'Join with invite code'}
      </button>
    </form>
  </div>
);

const CheckingView = (): JSX.Element => (
  <div className="flex flex-col items-center gap-4">
    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
    <p className="text-sm text-muted-foreground">Checking your access...</p>
  </div>
);

const SubscribeView = ({
  subscribing,
  onSubscribe,
  form,
}: {
  subscribing: boolean;
  onSubscribe: () => void;
  form: InviteCodeFormProps;
}): JSX.Element => (
  <>
    <h1 className="text-2xl font-semibold text-foreground mb-2">You&apos;re off the waitlist!</h1>
    <p className="text-muted-foreground mb-8">
      Subscribe to unlock Rose and start putting your agents to work.
    </p>
    <button
      type="button"
      onClick={onSubscribe}
      disabled={subscribing}
      className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {subscribing ? 'Opening checkout...' : 'Subscribe'}
    </button>
    <div className="mt-8">
      <InviteCodeForm {...form} />
    </div>
  </>
);

const WaitlistBody = ({ form }: { form: InviteCodeFormProps }): JSX.Element => (
  <>
    <h1 className="text-2xl font-semibold text-foreground mb-2">You&apos;re On The Waitlist!</h1>
    <p className="text-muted-foreground mb-8">
      Rose is rolling out gradually. We&apos;ll text you as soon as it&apos;s your turn.
    </p>
    <InviteCodeForm {...form} />
  </>
);

/**
 * Resolves the terminal onboarding screen from the server gate and re-checks it
 * when the window regains focus on the subscribe screen — so a user who
 * subscribed in the external browser is let through on return instead of being
 * stuck until relaunch.
 */
const useWaitlistGate = (onComplete: () => void): WaitlistScreen => {
  const { checkWaitlistStatus } = useOnboardingWaitlistApi();
  const [screen, setScreen] = useState<WaitlistScreen>('checking');
  const mounted = useRef(true);

  const resolve = useCallback(async (): Promise<void> => {
    try {
      const status = await checkWaitlistStatus();
      if (!mounted.current) return;
      if (!status.needsInviteCode) onComplete();
      else setScreen(status.offWaitlist ? 'subscribe' : 'waitlist');
    } catch {
      // Fail closed: show the waitlist view; a valid code still lets the user in.
      if (mounted.current) setScreen('waitlist');
    }
  }, [checkWaitlistStatus, onComplete]);

  useEffect(() => {
    mounted.current = true;
    void resolve();
    return () => {
      mounted.current = false;
    };
  }, [resolve]);

  useEffect(() => {
    if (screen !== 'subscribe') return undefined;
    const onFocus = (): void => void resolve();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [screen, resolve]);

  return screen;
};

const OnboardingWaitlist = ({ onComplete }: OnboardingWaitlistProps): JSX.Element => {
  const { redeemInviteCode, createSubscriptionCheckoutUrl } = useOnboardingWaitlistApi();
  const screen = useWaitlistGate(onComplete);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    void redeemInviteCode(Number(code))
      .then(() => onComplete())
      .catch((err: unknown) => {
        setError(getErrorMessageOrFallback(err, 'Invalid invite code'));
        setSubmitting(false);
      });
  };

  const handleSubscribe = (): void => {
    setSubscribing(true);
    void createSubscriptionCheckoutUrl()
      .then((url) => openExternal(url))
      .catch(() => openExternal(SUBSCRIBE_FALLBACK_URL))
      .finally(() => setSubscribing(false));
  };

  const form: InviteCodeFormProps = {
    code,
    error,
    submitting,
    onSubmit: handleSubmit,
    onCodeChange: (value: string): void => {
      setCode(value);
      setError(null);
    },
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm text-center">
        {screen === 'checking' ? (
          <CheckingView />
        ) : screen === 'subscribe' ? (
          <SubscribeView subscribing={subscribing} onSubscribe={handleSubscribe} form={form} />
        ) : (
          <WaitlistBody form={form} />
        )}
      </div>
    </div>
  );
};

export default OnboardingWaitlist;
