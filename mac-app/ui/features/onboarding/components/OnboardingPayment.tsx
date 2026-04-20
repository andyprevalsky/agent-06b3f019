/**
 * STATE MACHINE: OnboardingPayment
 *
 *   [CHOICE] ──(click Subscribe)──> open Stripe URL → [WAITING]
 *       │
 *       └──(enter bypass code)──> validate → [SUCCESS] onComplete()
 *                                          │
 *                                          └── (invalid) → show error → [CHOICE]
 *
 *   [WAITING] ──(IPC: payment success)──> onComplete()
 *       │
 *       └──(IPC: payment failure)──> [CHOICE]
 */

import { useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import { BYPASS_CODE, getStripePaymentUrl } from '../config';

interface OnboardingPaymentProps {
  onComplete: () => void;
}

interface PaymentChoiceProps {
  onOpenPayment: () => void;
  bypassCode: string;
  bypassError: boolean;
  onBypassSubmit: (e: React.FormEvent) => void;
  onBypassCodeChange: (value: string) => void;
}

const PaymentChoice = ({
  onOpenPayment,
  bypassCode,
  bypassError,
  onBypassSubmit,
  onBypassCodeChange,
}: PaymentChoiceProps): JSX.Element => (
  <div className="space-y-6">
    <button
      onClick={onOpenPayment}
      className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2"
    >
      Subscribe
      <ExternalLink className="w-3.5 h-3.5" />
    </button>

    <div className="flex items-center gap-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs text-muted-foreground">or enter invite code</span>
      <div className="flex-1 h-px bg-border" />
    </div>

    <form onSubmit={onBypassSubmit} className="space-y-3">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        placeholder="000000"
        value={bypassCode}
        onChange={(e) => {
          onBypassCodeChange(e.target.value.replace(/\D/g, ''));
        }}
        className="w-full px-3 py-3 bg-muted/30 border border-border rounded-xl text-foreground text-center text-sm font-mono tracking-widest placeholder-muted-foreground/30 focus:outline-none focus:border-foreground/20 transition-all"
      />
      {bypassError ? <p className="text-sm text-destructive">Invalid code</p> : null}
      <button
        type="submit"
        disabled={bypassCode.length !== 6}
        className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Continue
      </button>
    </form>
  </div>
);

const OnboardingPayment = ({ onComplete }: OnboardingPaymentProps): JSX.Element => {
  const [waitingForPayment, setWaitingForPayment] = useState(false);
  const [bypassCode, setBypassCode] = useState('');
  const [bypassError, setBypassError] = useState(false);

  useEffect(() => {
    const handlePaymentComplete = (data: { success: boolean }): void => {
      if (data.success) {
        onComplete();
      } else {
        setWaitingForPayment(false);
      }
    };

    window.api.onPaymentComplete(handlePaymentComplete);

    return () => {
      window.api.removePaymentCompleteListener();
    };
  }, [onComplete]);

  const handleOpenPayment = (): void => {
    setWaitingForPayment(true);
    void window.api.openExternal(getStripePaymentUrl());
  };

  const handleBypassSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (bypassCode === BYPASS_CODE) {
      onComplete();
    } else {
      setBypassError(true);
    }
  };

  const handleBypassCodeChange = (value: string): void => {
    setBypassCode(value);
    setBypassError(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">Complete Your Setup</h1>
        <p className="text-muted-foreground mb-8">Subscribe to Rose to unlock all features</p>

        {waitingForPayment ? (
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Waiting for payment confirmation...</p>
          </div>
        ) : (
          <PaymentChoice
            onOpenPayment={handleOpenPayment}
            bypassCode={bypassCode}
            bypassError={bypassError}
            onBypassSubmit={handleBypassSubmit}
            onBypassCodeChange={handleBypassCodeChange}
          />
        )}
      </div>
    </div>
  );
};

export default OnboardingPayment;
