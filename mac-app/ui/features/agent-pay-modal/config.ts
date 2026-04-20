/**
 * Config for the agent-pay-modal feature: defaults and shared strings used
 * to initialise/reset form state and as error messages.
 */

import type { PaymentData } from '@/lib/encryption';
import type { ShippingAddress } from './types';

export const DEFAULT_COUNTRY = 'United States';

// Default autopay limit: $100.00 = 10_000 cents. Mirrored in the display
// string so the visible value matches the canonical cents number on mount.
export const DEFAULT_AUTOPAY_LIMIT_CENTS = 10_000;
export const DEFAULT_AUTOPAY_LIMIT_DISPLAY = '100.00';

export const EMPTY_PAYMENT_DATA: PaymentData = {
  card_number: '',
  cardholder_name: '',
  card_expiry: '',
  card_cvv: '',
  billing_street_address: '',
  billing_address_line2: '',
  billing_city: '',
  billing_state: '',
  billing_zipcode: '',
  billing_country: DEFAULT_COUNTRY,
  billing_phone: '',
  billing_email: '',
  autoagentpaylimit_cents: DEFAULT_AUTOPAY_LIMIT_CENTS,
};

export const EMPTY_SHIPPING_ADDRESS: ShippingAddress = {
  name: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: DEFAULT_COUNTRY,
};

// Error surface: the PATCH failure banner deliberately hides upstream stack
// traces. The save-failure blackbox asserts both this literal and the
// absence of the thrown `Error.message` on 5xx responses.
export const SAVE_FAILURE_MESSAGE = 'Failed to save payment information';
export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';
export const GENERIC_SAVE_FAILURE_FALLBACK = 'Failed to save';
