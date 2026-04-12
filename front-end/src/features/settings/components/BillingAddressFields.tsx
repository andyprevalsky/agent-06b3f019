import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PaymentData } from '@/lib/encryption';

interface BillingAddressFieldsProps {
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  setPaymentData: React.Dispatch<React.SetStateAction<PaymentData>>;
}

function BillingCityState({
  paymentData,
  paymentErrors,
  setPaymentData,
}: BillingAddressFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="billingCity">City</Label>
        <Input
          id="billingCity"
          placeholder="New York"
          value={paymentData.billing_city}
          onChange={(e) => setPaymentData((prev) => ({ ...prev, billing_city: e.target.value }))}
          className={paymentErrors.billing_city ? 'border-destructive' : ''}
        />
        {paymentErrors.billing_city && (
          <p className="text-sm text-destructive">{paymentErrors.billing_city}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingState">State</Label>
        <Input
          id="billingState"
          placeholder="NY"
          value={paymentData.billing_state}
          onChange={(e) => setPaymentData((prev) => ({ ...prev, billing_state: e.target.value }))}
          className={paymentErrors.billing_state ? 'border-destructive' : ''}
        />
        {paymentErrors.billing_state && (
          <p className="text-sm text-destructive">{paymentErrors.billing_state}</p>
        )}
      </div>
    </div>
  );
}

function BillingZipCountry({
  paymentData,
  paymentErrors,
  setPaymentData,
}: BillingAddressFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="billingZip">ZIP Code</Label>
        <Input
          id="billingZip"
          placeholder="10001"
          value={paymentData.billing_zipcode}
          onChange={(e) =>
            setPaymentData((prev) => ({
              ...prev,
              billing_zipcode: e.target.value,
            }))
          }
          className={paymentErrors.billing_zipcode ? 'border-destructive' : ''}
        />
        {paymentErrors.billing_zipcode && (
          <p className="text-sm text-destructive">{paymentErrors.billing_zipcode}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingCountry">Country</Label>
        <Input
          id="billingCountry"
          placeholder="United States"
          value={paymentData.billing_country}
          onChange={(e) =>
            setPaymentData((prev) => ({
              ...prev,
              billing_country: e.target.value,
            }))
          }
          className={paymentErrors.billing_country ? 'border-destructive' : ''}
        />
        {paymentErrors.billing_country && (
          <p className="text-sm text-destructive">{paymentErrors.billing_country}</p>
        )}
      </div>
    </div>
  );
}

export default function BillingAddressFields({
  paymentData,
  paymentErrors,
  setPaymentData,
}: BillingAddressFieldsProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Billing Address</h3>

      <div className="space-y-2">
        <Label htmlFor="billingStreet">Street Address</Label>
        <Input
          id="billingStreet"
          placeholder="123 Main Street"
          value={paymentData.billing_street_address}
          onChange={(e) =>
            setPaymentData((prev) => ({
              ...prev,
              billing_street_address: e.target.value,
            }))
          }
          className={paymentErrors.billing_street_address ? 'border-destructive' : ''}
        />
        {paymentErrors.billing_street_address && (
          <p className="text-sm text-destructive">{paymentErrors.billing_street_address}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingLine2">Address Line 2 (Optional)</Label>
        <Input
          id="billingLine2"
          placeholder="Apt 4B, Suite 100, etc."
          value={paymentData.billing_address_line2}
          onChange={(e) =>
            setPaymentData((prev) => ({
              ...prev,
              billing_address_line2: e.target.value,
            }))
          }
        />
      </div>

      <BillingCityState
        paymentData={paymentData}
        paymentErrors={paymentErrors}
        setPaymentData={setPaymentData}
      />

      <BillingZipCountry
        paymentData={paymentData}
        paymentErrors={paymentErrors}
        setPaymentData={setPaymentData}
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="billingPhone">Phone (Optional)</Label>
          <Input
            id="billingPhone"
            placeholder="+1 555-123-4567"
            value={paymentData.billing_phone}
            onChange={(e) => setPaymentData((prev) => ({ ...prev, billing_phone: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="billingEmail">Email (Optional)</Label>
          <Input
            id="billingEmail"
            placeholder="john@example.com"
            type="email"
            value={paymentData.billing_email}
            onChange={(e) => setPaymentData((prev) => ({ ...prev, billing_email: e.target.value }))}
            className={paymentErrors.billing_email ? 'border-destructive' : ''}
          />
          {paymentErrors.billing_email && (
            <p className="text-sm text-destructive">{paymentErrors.billing_email}</p>
          )}
        </div>
      </div>
    </div>
  );
}
