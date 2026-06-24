import { useState, useEffect, useCallback } from 'react';
import {
  parsePaymentEnvelope,
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
  if (pd.autoagentpaylimit_cents < 0) errors.autoagentpaylimit_cents = 'Must be 0 or greater';
  return errors;
}

function parseAutopayLimit(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { autoagentpaylimit_cents?: unknown };
    return typeof parsed.autoagentpaylimit_cents === 'number'
      ? parsed.autoagentpaylimit_cents
      : null;
  } catch {
    const envelope = parsePaymentEnvelope(raw);
    return envelope?.autoagentpaylimit_cents ?? null;
  }
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
    const autopayLimit = parseAutopayLimit(userData.encryptedPaymentInformation);
    if (autopayLimit !== null) {
      setSavedPaymentEnvelope(parsePaymentEnvelope(userData.encryptedPaymentInformation));
      setAutopayLimitDisplay((autopayLimit / 100).toFixed(2));
      setPaymentData((prev) => ({
        ...prev,
        autoagentpaylimit_cents: autopayLimit,
      }));
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
      const data = await savePaymentApi(
        JSON.stringify({
          version: 'agentcard-autopay-v1',
          autoagentpaylimit_cents: cents,
        }),
      );
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

  const handleCardNumber = useCallback(() => {}, []);
  const handleExpiry = useCallback(() => {}, []);
  const handleCVV = useCallback(() => {}, []);

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
    currentCardType: 'unknown',
    savePaymentInfo,
    handleCardNumber,
    handleExpiry,
    handleCVV,
    handleAutopayBlur,
  };
}
