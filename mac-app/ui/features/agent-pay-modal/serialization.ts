import {
  encryptPaymentData,
  parsePaymentEnvelope,
  type EncryptedPaymentEnvelope,
  type PaymentData,
} from '@/lib/encryption';
import type { ShippingAddress, UserSettingsPatchBody, UserSettingsResponse } from './types';

/**
 * Pure (de)serialization helpers for the agent-pay modal. Separated from
 * the hook layer so the request/response shapes are reviewable in isolation
 * and can be unit-tested without React.
 */

export interface InitialFetchOutcome {
  shippingAddress: ShippingAddress;
  savedEnvelope: EncryptedPaymentEnvelope | null;
  editingCard: boolean;
  autopayLimitDisplay: string | null;
}

/**
 * Parse a GET /api/user-settings response into the bits the hook needs.
 * Returns `editingCard: true` (i.e. show the card form) whenever the
 * response has no usable envelope so the user lands on a fillable form.
 */
export const parseInitialFetch = (data: UserSettingsResponse): InitialFetchOutcome => {
  const shippingAddress: ShippingAddress = {
    name: data.name ?? '',
    addressLine1: data.addressLine1 ?? '',
    addressLine2: data.addressLine2 ?? '',
    city: data.city ?? '',
    state: data.state ?? '',
    postalCode: data.postalCode ?? '',
    country: data.country ?? 'United States',
  };
  const envelopeStr = data.encryptedPaymentInformation;
  if (envelopeStr !== undefined && envelopeStr !== '') {
    const envelope = parsePaymentEnvelope(envelopeStr);
    if (envelope !== null) {
      return {
        shippingAddress,
        savedEnvelope: envelope,
        editingCard: false,
        autopayLimitDisplay: (envelope.autoagentpaylimit_cents / 100).toFixed(2),
      };
    }
  }
  return { shippingAddress, savedEnvelope: null, editingCard: true, autopayLimitDisplay: null };
};

/**
 * Builds the PATCH body. When `showCardForm` is false we deliberately omit
 * `encryptedPaymentInformation` so the backend keeps the previously saved
 * envelope untouched (asserted by the "saved card, no edit" blackbox).
 */
export const buildPatchBody = async (
  paymentData: PaymentData,
  shippingAddress: ShippingAddress,
  autopayLimitDisplay: string,
  showCardForm: boolean,
  sameAsBilling: boolean
): Promise<UserSettingsPatchBody> => {
  const updatePayload: UserSettingsPatchBody = {};
  if (showCardForm) {
    const dollars = parseFloat(autopayLimitDisplay) || 0;
    const cents = Math.round(dollars * 100);
    const dataToSave: PaymentData = { ...paymentData, autoagentpaylimit_cents: cents };
    updatePayload.encryptedPaymentInformation = await encryptPaymentData(dataToSave);
  }
  const shippingData = sameAsBilling
    ? {
        name: paymentData.cardholder_name,
        addressLine1: paymentData.billing_street_address,
        addressLine2: paymentData.billing_address_line2,
        city: paymentData.billing_city,
        state: paymentData.billing_state,
        postalCode: paymentData.billing_zipcode,
        country: paymentData.billing_country,
      }
    : shippingAddress;
  updatePayload.name = shippingData.name;
  updatePayload.addressLine1 = shippingData.addressLine1;
  updatePayload.addressLine2 = shippingData.addressLine2;
  updatePayload.city = shippingData.city;
  updatePayload.state = shippingData.state;
  updatePayload.postalCode = shippingData.postalCode;
  updatePayload.country = shippingData.country;
  return updatePayload;
};
