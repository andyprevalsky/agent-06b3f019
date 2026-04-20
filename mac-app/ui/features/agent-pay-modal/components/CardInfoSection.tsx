import { detectCardType, type PaymentData } from '@/lib/encryption';
import { CardIcons } from './CardIcons';
import { FormInput } from './FormInput';

interface CardInfoSectionProps {
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  saving: boolean;
  handleCardNumber: (value: string) => void;
  handleExpiry: (value: string) => void;
  handleCVV: (value: string) => void;
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]) => void;
}

/**
 * Card Number + Cardholder + Expiry + CVV fields. Card-number input also
 * renders the live-detected brand icon in its trailing affordance.
 */
export const CardInfoSection = ({
  paymentData,
  paymentErrors,
  saving,
  handleCardNumber,
  handleExpiry,
  handleCVV,
  setPaymentField,
}: CardInfoSectionProps) => {
  const currentCardType = detectCardType(paymentData.card_number);
  const cvvError = paymentErrors.card_cvv;
  const hasCardNumberError =
    paymentErrors.card_number !== undefined && paymentErrors.card_number !== '';
  const cardNumberClass = `w-full px-3 py-2 text-sm bg-surface border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 pr-10 ${
    hasCardNumberError ? 'border-red-500' : 'border-border'
  }`;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Card Information</h3>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Card Number</label>
        <div className="relative">
          <input
            placeholder="4111 1111 1111 1111"
            value={paymentData.card_number}
            onChange={(e) => handleCardNumber(e.target.value)}
            maxLength={19}
            disabled={saving}
            className={cardNumberClass}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            {CardIcons[currentCardType] ?? CardIcons.unknown}
          </div>
        </div>
        {hasCardNumberError && <p className="text-xs text-red-500">{paymentErrors.card_number}</p>}
      </div>

      <FormInput
        label="Cardholder Name"
        placeholder="John Doe"
        value={paymentData.cardholder_name}
        onChange={(v) => setPaymentField('cardholder_name', v)}
        error={paymentErrors.cardholder_name}
        disabled={saving}
      />

      <div className="grid grid-cols-2 gap-3">
        <FormInput
          label="Expiry Date"
          placeholder="MM/YY"
          value={paymentData.card_expiry}
          onChange={handleExpiry}
          error={paymentErrors.card_expiry}
          disabled={saving}
          maxLength={5}
        />
        <FormInput
          label="CVV"
          placeholder={currentCardType === 'amex' ? '1234' : '123'}
          value={paymentData.card_cvv}
          onChange={handleCVV}
          error={cvvError}
          disabled={saving}
          maxLength={4}
          type="password"
        />
      </div>
    </div>
  );
};
