import { useState, useEffect, useCallback } from 'react';
import {
  encryptPaymentData,
  parsePaymentEnvelope,
  detectCardType,
  validateCardNumber,
  validateExpiry,
  validateCVV,
  type PaymentData,
  type EncryptedPaymentEnvelope,
} from '@/lib/encryption';

import type { UserData } from '../types';
import { savePaymentApi } from '../api';

export interface PaymentResult {
  showPaymentForm: boolean;
  setShowPaymentForm: (v: boolean) => void;
  paymentData: PaymentData;
  setPaymentData: React.Dispatch<React.SetStateAction<PaymentData>>;
  paymentErrors: Record<string, string>;
  setPaymentErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingPayment: boolean;
  savedPayment: boolean;
  autopayLimitDisplay: string;
  setAutopayLimitDisplay: (v: string) => void;
  savedPaymentEnvelope: EncryptedPaymentEnvelope | null;
  currentCardType: string;
  savePaymentInfo: () => Promise<void>;
  handleCardNumber: (value: string) => void;
  handleExpiry: (value: string) => void;
  handleCVV: (value: string) => void;
  handleAutopayBlur: () => void;
}

const INITIAL_PAYMENT: PaymentData = {
  card_number: '',
  cardholder_name: '',
  card_expiry: '',
  card_cvv: '',
  billing_street_address: '',
  billing_address_line2: '',
  billing_city: '',
  billing_state: '',
  billing_zipcode: '',
  billing_country: 'United States',
  billing_phone: '',
  billing_email: '',
  autoagentpaylimit_cents: 10000,
};

function validatePaymentFields(pd: PaymentData): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!pd.card_number) {
    errors.card_number = 'Card number is required';
  } else if (!validateCardNumber(pd.card_number)) {
    errors.card_number = 'Invalid card number';
  }
  if (!pd.cardholder_name.trim()) errors.cardholder_name = 'Cardholder name is required';
  if (!pd.card_expiry) {
    errors.card_expiry = 'Expiry date is required';
  } else if (!validateExpiry(pd.card_expiry)) {
    errors.card_expiry = 'Invalid or expired date';
  }
  const cardType = detectCardType(pd.card_number);
  if (!pd.card_cvv) {
    errors.card_cvv = 'CVV is required';
  } else if (!validateCVV(pd.card_cvv, cardType)) {
    errors.card_cvv = cardType === 'amex' ? 'Must be 4 digits' : 'Must be 3 digits';
  }
  if (!pd.billing_street_address.trim())
    errors.billing_street_address = 'Street address is required';
  if (!pd.billing_city.trim()) errors.billing_city = 'City is required';
  if (!pd.billing_state.trim()) errors.billing_state = 'State is required';
  if (!pd.billing_zipcode.trim()) errors.billing_zipcode = 'ZIP code is required';
  if (!pd.billing_country.trim()) errors.billing_country = 'Country is required';
  if (pd.billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pd.billing_email)) {
    errors.billing_email = 'Invalid email format';
  }
  if (pd.autoagentpaylimit_cents < 0) errors.autoagentpaylimit_cents = 'Must be 0 or greater';
  return errors;
}

/** Manages payment form state, validation, and saving. */
// eslint-disable-next-line max-lines-per-function
export function usePayment(
  userData: UserData,
  setUserData: React.Dispatch<React.SetStateAction<UserData>>,
  setError: (e: string | null) => void,
): PaymentResult {
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentData, setPaymentData] = useState<PaymentData>({ ...INITIAL_PAYMENT });
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({});
  const [savingPayment, setSavingPayment] = useState(false);
  const [savedPayment, setSavedPayment] = useState(false);
  const [autopayLimitDisplay, setAutopayLimitDisplay] = useState('100.00');
  const [savedPaymentEnvelope, setSavedPaymentEnvelope] = useState<EncryptedPaymentEnvelope | null>(
    null,
  );

  useEffect(() => {
    if (userData.encryptedPaymentInformation) {
      const envelope = parsePaymentEnvelope(userData.encryptedPaymentInformation);
      setSavedPaymentEnvelope(envelope);
      if (envelope) {
        setAutopayLimitDisplay((envelope.autoagentpaylimit_cents / 100).toFixed(2));
        setPaymentData((prev) => ({
          ...prev,
          autoagentpaylimit_cents: envelope.autoagentpaylimit_cents,
        }));
      }
    } else {
      setSavedPaymentEnvelope(null);
    }
  }, [userData.encryptedPaymentInformation]);

  const savePaymentInfo = useCallback(async () => {
    const dollars = parseFloat(autopayLimitDisplay) || 0;
    const cents = Math.round(dollars * 100);
    const dataToSave = { ...paymentData, autoagentpaylimit_cents: cents };
    const errors = validatePaymentFields(dataToSave);
    setPaymentErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      setSavingPayment(true);
      setError(null);
      setSavedPayment(false);
      const encryptedData = await encryptPaymentData(dataToSave);
      const data = await savePaymentApi(encryptedData);
      setUserData((prev) => ({
        ...prev,
        encryptedPaymentInformation: data.encryptedPaymentInformation as string,
      }));
      setSavedPayment(true);
      setShowPaymentForm(false);
      setPaymentData({ ...INITIAL_PAYMENT, autoagentpaylimit_cents: cents });
      setAutopayLimitDisplay((cents / 100).toFixed(2));
      setPaymentErrors({});
      setTimeout(() => setSavedPayment(false), 3000);
    } catch (err) {
      console.error('Failed to save payment info:', err);
      setError(err instanceof Error ? err.message : 'Failed to save payment information');
    } finally {
      setSavingPayment(false);
    }
  }, [autopayLimitDisplay, paymentData, setError, setUserData]);

  const handleCardNumber = useCallback((value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
    setPaymentData((prev) => ({ ...prev, card_number: formatted }));
  }, []);

  const handleExpiry = useCallback((value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    const formatted = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    setPaymentData((prev) => ({ ...prev, card_expiry: formatted }));
  }, []);

  const handleCVV = useCallback((value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    setPaymentData((prev) => ({ ...prev, card_cvv: digits }));
  }, []);

  const handleAutopayBlur = useCallback(() => {
    const dollars = parseFloat(autopayLimitDisplay) || 0;
    setPaymentData((prev) => ({ ...prev, autoagentpaylimit_cents: Math.round(dollars * 100) }));
  }, [autopayLimitDisplay]);

  return {
    showPaymentForm,
    setShowPaymentForm,
    paymentData,
    setPaymentData,
    paymentErrors,
    setPaymentErrors,
    savingPayment,
    savedPayment,
    autopayLimitDisplay,
    setAutopayLimitDisplay,
    savedPaymentEnvelope,
    currentCardType: detectCardType(paymentData.card_number),
    savePaymentInfo,
    handleCardNumber,
    handleExpiry,
    handleCVV,
    handleAutopayBlur,
  };
}
