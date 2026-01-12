import { useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';

const STRIPE_PAYMENT_URL_PROD = 'https://buy.stripe.com/6oU00k2kK1vi8bLdL8bQY00';
const STRIPE_PAYMENT_URL_DEV = 'https://buy.stripe.com/test_5kQcN64tX2PccvS6dM9ws00';

const isDev = import.meta.env.DEV;
const STRIPE_PAYMENT_URL = isDev ? STRIPE_PAYMENT_URL_DEV : STRIPE_PAYMENT_URL_PROD;

interface OnboardingPaymentProps {
  onComplete: () => void;
}

const OnboardingPayment = ({ onComplete }: OnboardingPaymentProps) => {
  const [waitingForPayment, setWaitingForPayment] = useState(false);

  useEffect(() => {
    // Listen for payment completion from deep link
    const handlePaymentComplete = (data: { success: boolean }) => {
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

  const handleOpenPayment = async () => {
    setWaitingForPayment(true);
    // Open Stripe in external browser
    await window.api.openExternal(STRIPE_PAYMENT_URL);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          Complete Your Setup
        </h1>
        <p className="text-muted-foreground mb-8">
          Subscribe to Rose to unlock all features
        </p>

        {waitingForPayment ? (
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Waiting for payment confirmation...
            </p>
            {/* Dev mode: manual confirmation since deep links don't work in dev */}
            {isDev && (
              <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-center">
                <p className="text-xs text-amber-500 mb-2">
                  Deep links don't work in dev mode. After completing payment in your browser, click below to continue. (In production, this is automatic.)
                </p>
                <button
                  onClick={onComplete}
                  className="text-sm text-amber-500 hover:text-amber-400 underline font-medium"
                >
                  I've completed payment
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={handleOpenPayment}
            className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2"
          >
            Subscribe
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

export default OnboardingPayment;
