import { useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';

const STRIPE_PAYMENT_URL_PROD = 'https://buy.stripe.com/6oU00k2kK1vi8bLdL8bQY00';
const STRIPE_PAYMENT_URL_DEV = 'https://buy.stripe.com/test_5kQcN64tX2PccvS6dM9ws00';

const isDev = Boolean(import.meta.env.DEV);
const STRIPE_PAYMENT_URL = isDev ? STRIPE_PAYMENT_URL_DEV : STRIPE_PAYMENT_URL_PROD;

const BYPASS_CODE = '181818';

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
}: PaymentChoiceProps) => (
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

const OnboardingPayment = ({ onComplete }: OnboardingPaymentProps) => {
  const [waitingForPayment, setWaitingForPayment] = useState(false);
  const [bypassCode, setBypassCode] = useState('');
  const [bypassError, setBypassError] = useState(false);

  console.log('[OnboardingPayment] Rendered', { waitingForPayment, bypassCode, bypassError });

  useEffect(() => {
    const handlePaymentComplete = (data: { success: boolean }) => {
      console.log('[OnboardingPayment] Payment complete callback received', data);
      if (data.success) {
        console.log('[OnboardingPayment] Payment succeeded, calling onComplete');
        onComplete();
      } else {
        console.log('[OnboardingPayment] Payment failed, resetting waitingForPayment');
        setWaitingForPayment(false);
      }
    };

    window.api.onPaymentComplete(handlePaymentComplete);
    console.log('[OnboardingPayment] Registered payment complete listener');

    return () => {
      window.api.removePaymentCompleteListener();
      console.log('[OnboardingPayment] Removed payment complete listener');
    };
  }, [onComplete]);

  const handleOpenPayment = () => {
    console.log('[OnboardingPayment] Opening Stripe payment URL', { url: STRIPE_PAYMENT_URL });
    setWaitingForPayment(true);
    void window.api.openExternal(STRIPE_PAYMENT_URL);
  };

  const handleBypassSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[OnboardingPayment] Bypass code submitted', {
      codeLength: bypassCode.length,
      matches: bypassCode === BYPASS_CODE,
    });
    if (bypassCode === BYPASS_CODE) {
      console.log('[OnboardingPayment] Bypass code accepted, calling onComplete');
      onComplete();
    } else {
      console.log('[OnboardingPayment] Bypass code rejected');
      setBypassError(true);
    }
  };

  const handleBypassCodeChange = (value: string) => {
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
