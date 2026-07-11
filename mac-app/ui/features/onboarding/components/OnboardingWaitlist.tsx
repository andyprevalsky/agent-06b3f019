/**
 * STATE MACHINE: OnboardingWaitlist
 *
 *   [CHECKING] ──(needsInviteCode=false)──> onComplete()   // already invited
 *       │
 *       └──(needsInviteCode=true | check failed)──> [WAITLIST]
 *
 *   [WAITLIST] ──(submit code)──> [SUBMITTING] ──(server accepts)──> onComplete()
 *       ▲                              │
 *       └───────(server rejects: inline error)──────────┘
 *
 * Persistence: the gate lives server-side (User.usedInviteCode via
 * GET /api/invite-codes/check), so relaunching the app re-shows the same
 * waitlist view until a valid invite code is redeemed.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getErrorMessageOrFallback } from '../../../../shared/utils/error';
import { checkNeedsInviteCode, redeemInviteCode } from '../api';

const INVITE_CODE_LENGTH = 6;

interface OnboardingWaitlistProps {
  onComplete: () => void;
}

interface WaitlistViewProps {
  code: string;
  error: string | null;
  submitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCodeChange: (value: string) => void;
}

const WaitlistView = ({
  code,
  error,
  submitting,
  onSubmit,
  onCodeChange,
}: WaitlistViewProps): JSX.Element => (
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

const OnboardingWaitlist = ({ onComplete }: OnboardingWaitlistProps): JSX.Element => {
  const [checking, setChecking] = useState(true);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkNeedsInviteCode()
      .then((needsInvite) => {
        if (cancelled) return;
        if (needsInvite) {
          setChecking(false);
        } else {
          onComplete();
        }
      })
      .catch(() => {
        // Fail closed: show the waitlist view; a valid code still lets the user through.
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onComplete]);

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

  const handleCodeChange = (value: string): void => {
    setCode(value);
    setError(null);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm text-center">
        {checking ? (
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Checking your access...</p>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-foreground mb-2">
              You&apos;re On The Waitlist!
            </h1>
            <p className="text-muted-foreground mb-8">
              Rose is rolling out gradually. We&apos;ll text you as soon as it&apos;s your turn.
            </p>
            <WaitlistView
              code={code}
              error={error}
              submitting={submitting}
              onSubmit={handleSubmit}
              onCodeChange={handleCodeChange}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default OnboardingWaitlist;
