import type { PaymentData } from '@/lib/encryption';
import { BillingAddressSection } from './BillingAddressSection';
import { CardInfoSection } from './CardInfoSection';

interface CardFormProps {
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  autopayLimitDisplay: string;
  saving: boolean;
  setAutopayLimitDisplay: (value: string) => void;
  handleAutopayBlur: () => void;
  handleCardNumber: (value: string) => void;
  handleExpiry: (value: string) => void;
  handleCVV: (value: string) => void;
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]) => void;
}

/**
 * The full autopay-limit + card-info + billing-address form. Only rendered
 * when `showCardForm` in the parent is true (no saved card, or user clicked
 * Update). All field handlers come from the hook; this component is pure UI.
 */
export const CardForm = ({
  paymentData,
  paymentErrors,
  autopayLimitDisplay,
  saving,
  setAutopayLimitDisplay,
  handleAutopayBlur,
  handleCardNumber,
  handleExpiry,
  handleCVV,
  setPaymentField,
}: CardFormProps) => (
  <>
    {/* Autopay Limit */}
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">Autopay Limit ($)</label>
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="100.00"
        value={autopayLimitDisplay}
        onChange={(e) => setAutopayLimitDisplay(e.target.value)}
        onBlur={handleAutopayBlur}
        className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 max-w-[160px]"
      />
      <p className="text-xs text-muted-foreground">
        Payments under this amount are auto-approved. Set to $0 to require approval for all.
      </p>
    </div>

    <CardInfoSection
      paymentData={paymentData}
      paymentErrors={paymentErrors}
      saving={saving}
      handleCardNumber={handleCardNumber}
      handleExpiry={handleExpiry}
      handleCVV={handleCVV}
      setPaymentField={setPaymentField}
    />

    <BillingAddressSection
      paymentData={paymentData}
      paymentErrors={paymentErrors}
      saving={saving}
      setPaymentField={setPaymentField}
    />
  </>
);
