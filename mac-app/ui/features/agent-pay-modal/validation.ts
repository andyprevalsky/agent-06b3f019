import {
  detectCardType,
  validateCardNumber,
  validateExpiry,
  validateCVV,
  type PaymentData,
} from '@/lib/encryption';
import type { ShippingAddress } from './types';

/**
 * Pure form-validation logic for the agent-pay modal. Kept out of the
 * React hook layer so the rules are reviewable in isolation.
 */

const validateCardFields = (paymentData: PaymentData, errors: Record<string, string>): void => {
  if (paymentData.card_number === '') {
    errors.card_number = 'Card number is required';
  } else if (!validateCardNumber(paymentData.card_number)) {
    errors.card_number = 'Invalid card number';
  }
  if (paymentData.cardholder_name.trim() === '') {
    errors.cardholder_name = 'Cardholder name is required';
  }
  if (paymentData.card_expiry === '') {
    errors.card_expiry = 'Expiry date is required';
  } else if (!validateExpiry(paymentData.card_expiry)) {
    errors.card_expiry = 'Invalid or expired date';
  }
  const cardType = detectCardType(paymentData.card_number);
  if (paymentData.card_cvv === '') {
    errors.card_cvv = 'CVV is required';
  } else if (!validateCVV(paymentData.card_cvv, cardType)) {
    errors.card_cvv = cardType === 'amex' ? 'Must be 4 digits' : 'Must be 3 digits';
  }
  if (paymentData.billing_street_address.trim() === '')
    errors.billing_street_address = 'Street address is required';
  if (paymentData.billing_city.trim() === '') errors.billing_city = 'City is required';
  if (paymentData.billing_state.trim() === '') errors.billing_state = 'State is required';
  if (paymentData.billing_zipcode.trim() === '') errors.billing_zipcode = 'ZIP code is required';
  if (paymentData.billing_country.trim() === '') errors.billing_country = 'Country is required';
};

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
  if (showCardForm) validateCardFields(paymentData, errors);
  if (!sameAsBilling) validateShippingFields(shippingAddress, errors);
  return errors;
};
