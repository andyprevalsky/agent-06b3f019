import type { ShippingAddress } from '../types';
import { FormInput } from './FormInput';

interface DeliveryAddressFieldsProps {
  shippingAddress: ShippingAddress;
  paymentErrors: Record<string, string>;
  saving: boolean;
  setShippingField: <K extends keyof ShippingAddress>(field: K, value: ShippingAddress[K]) => void;
}

/**
 * Inner fields of the delivery address block — only rendered when
 * `sameAsBilling` is false. Split out from `DeliveryAddressForm` to keep
 * each rendering function under the strict 80-line cap.
 */
export const DeliveryAddressFields = ({
  shippingAddress,
  paymentErrors,
  saving,
  setShippingField,
}: DeliveryAddressFieldsProps) => (
  <>
    <FormInput
      label="Full Name"
      placeholder="John Doe"
      value={shippingAddress.name}
      onChange={(v) => setShippingField('name', v)}
      error={paymentErrors.shipping_name}
      disabled={saving}
    />
    <FormInput
      label="Street Address"
      placeholder="123 Main Street"
      value={shippingAddress.addressLine1}
      onChange={(v) => setShippingField('addressLine1', v)}
      error={paymentErrors.shipping_addressLine1}
      disabled={saving}
    />
    <FormInput
      label="Address Line 2 (Optional)"
      placeholder="Apt 4B, Suite 100, etc."
      value={shippingAddress.addressLine2}
      onChange={(v) => setShippingField('addressLine2', v)}
      disabled={saving}
    />
    <div className="grid grid-cols-2 gap-3">
      <FormInput
        label="City"
        placeholder="New York"
        value={shippingAddress.city}
        onChange={(v) => setShippingField('city', v)}
        error={paymentErrors.shipping_city}
        disabled={saving}
      />
      <FormInput
        label="State"
        placeholder="NY"
        value={shippingAddress.state}
        onChange={(v) => setShippingField('state', v)}
        error={paymentErrors.shipping_state}
        disabled={saving}
      />
    </div>
    <div className="grid grid-cols-2 gap-3">
      <FormInput
        label="Postal Code"
        placeholder="10001"
        value={shippingAddress.postalCode}
        onChange={(v) => setShippingField('postalCode', v)}
        error={paymentErrors.shipping_postalCode}
        disabled={saving}
      />
      <FormInput
        label="Country"
        placeholder="United States"
        value={shippingAddress.country}
        onChange={(v) => setShippingField('country', v)}
        error={paymentErrors.shipping_country}
        disabled={saving}
      />
    </div>
  </>
);
