import { parsePaymentEnvelope, type EncryptedPaymentEnvelope, type PaymentData } from '@/lib/encryption';
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
    try {
      const parsed = JSON.parse(envelopeStr) as { autoagentpaylimit_cents?: unknown };
      if (typeof parsed.autoagentpaylimit_cents === 'number') {
        return {
          shippingAddress,
          savedEnvelope: null,
          editingCard: false,
          autopayLimitDisplay: (parsed.autoagentpaylimit_cents / 100).toFixed(2),
        };
      }
    } catch {
      // Fall through to legacy encrypted envelope parsing.
    }
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
 * Builds the PATCH body. Shopping card credentials are no longer collected;
 * `encryptedPaymentInformation` carries only the autopay limit marker until
 * a dedicated settings column is approved.
 */
export const buildPatchBody = async (
  paymentData: PaymentData,
  shippingAddress: ShippingAddress,
  autopayLimitDisplay: string,
  showCardForm: boolean,
  sameAsBilling: boolean
): Promise<UserSettingsPatchBody> => {
  const updatePayload: UserSettingsPatchBody = {};
  const dollars = parseFloat(autopayLimitDisplay) || 0;
  const cents = Math.round(dollars * 100);
  updatePayload.encryptedPaymentInformation = JSON.stringify({
    version: 'agentcard-autopay-v1',
    autoagentpaylimit_cents: cents,
  });
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
