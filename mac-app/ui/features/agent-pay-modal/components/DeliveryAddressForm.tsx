import type { ShippingAddress } from '../types';
import { DeliveryAddressFields } from './DeliveryAddressFields';

interface DeliveryAddressFormProps {
  shippingAddress: ShippingAddress;
  paymentErrors: Record<string, string>;
  sameAsBilling: boolean;
  showCardForm: boolean;
  saving: boolean;
  setSameAsBilling: (value: boolean) => void;
  setShippingField: <K extends keyof ShippingAddress>(field: K, value: ShippingAddress[K]) => void;
}

/**
 * Delivery (shipping) address block. Always rendered when the modal body
 * is visible. The "Same as billing" checkbox is only exposed when the
 * card form is visible (i.e. the user has a billing address to copy from);
 * toggling it collapses the entire delivery form.
 */
export const DeliveryAddressForm = ({
  shippingAddress,
  paymentErrors,
  sameAsBilling,
  showCardForm,
  saving,
  setSameAsBilling,
  setShippingField,
}: DeliveryAddressFormProps) => (
  <div className="space-y-3">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">Delivery Address</h3>
      {showCardForm && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sameAsBilling}
            onChange={(e) => setSameAsBilling(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-border"
          />
          <span className="text-xs text-muted-foreground">Same as billing</span>
        </label>
      )}
    </div>
    {!sameAsBilling && (
      <DeliveryAddressFields
        shippingAddress={shippingAddress}
        paymentErrors={paymentErrors}
        saving={saving}
        setShippingField={setShippingField}
      />
    )}
  </div>
);
