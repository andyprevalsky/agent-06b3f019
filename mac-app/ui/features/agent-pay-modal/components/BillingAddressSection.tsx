import type { PaymentData } from '@/lib/encryption';
import { FormInput } from './FormInput';

interface BillingAddressSectionProps {
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  saving: boolean;
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]) => void;
}

/**
 * Billing address fields for the cardholder. Separate from shipping /
 * delivery address — see `DeliveryAddressForm` for that.
 */
export const BillingAddressSection = ({
  paymentData,
  paymentErrors,
  saving,
  setPaymentField,
}: BillingAddressSectionProps) => (
  <div className="space-y-3">
    <h3 className="text-sm font-semibold text-foreground">Billing Address</h3>

    <FormInput
      label="Street Address"
      placeholder="123 Main Street"
      value={paymentData.billing_street_address}
      onChange={(v) => setPaymentField('billing_street_address', v)}
      error={paymentErrors.billing_street_address}
      disabled={saving}
    />

    <FormInput
      label="Address Line 2 (Optional)"
      placeholder="Apt 4B, Suite 100, etc."
      value={paymentData.billing_address_line2}
      onChange={(v) => setPaymentField('billing_address_line2', v)}
      disabled={saving}
    />

    <div className="grid grid-cols-2 gap-3">
      <FormInput
        label="City"
        placeholder="New York"
        value={paymentData.billing_city}
        onChange={(v) => setPaymentField('billing_city', v)}
        error={paymentErrors.billing_city}
        disabled={saving}
      />
      <FormInput
        label="State"
        placeholder="NY"
        value={paymentData.billing_state}
        onChange={(v) => setPaymentField('billing_state', v)}
        error={paymentErrors.billing_state}
        disabled={saving}
      />
    </div>

    <div className="grid grid-cols-2 gap-3">
      <FormInput
        label="ZIP Code"
        placeholder="10001"
        value={paymentData.billing_zipcode}
        onChange={(v) => setPaymentField('billing_zipcode', v)}
        error={paymentErrors.billing_zipcode}
        disabled={saving}
      />
      <FormInput
        label="Country"
        placeholder="United States"
        value={paymentData.billing_country}
        onChange={(v) => setPaymentField('billing_country', v)}
        error={paymentErrors.billing_country}
        disabled={saving}
      />
    </div>
  </div>
);
