import type { PaymentData } from '@/lib/encryption';
import type { ShippingAddress } from './types';

/**
 * Pure form-validation logic for the agent-pay modal. Kept out of the
 * React hook layer so the rules are reviewable in isolation.
 */

const validateShippingFields = (
  shippingAddress: ShippingAddress,
  errors: Record<string, string>
): void => {
  if (shippingAddress.name.trim() === '') errors.shipping_name = 'Name is required';
  if (shippingAddress.addressLine1.trim() === '')
    errors.shipping_addressLine1 = 'Address is required';
  if (shippingAddress.city.trim() === '') errors.shipping_city = 'City is required';
  if (shippingAddress.state.trim() === '') errors.shipping_state = 'State is required';
  if (shippingAddress.postalCode.trim() === '')
    errors.shipping_postalCode = 'Postal code is required';
  if (shippingAddress.country.trim() === '') errors.shipping_country = 'Country is required';
};

export const validateForm = (
  paymentData: PaymentData,
  shippingAddress: ShippingAddress,
  showCardForm: boolean,
  sameAsBilling: boolean
): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (paymentData.autoagentpaylimit_cents < 0) {
    errors.autoagentpaylimit_cents = 'Must be 0 or greater';
  }
  if (!sameAsBilling) validateShippingFields(shippingAddress, errors);
  return errors;
};
