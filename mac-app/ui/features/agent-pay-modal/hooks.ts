import { useEffect, useState } from 'react';
import { getSession } from '@/lib/supabase';
import { type EncryptedPaymentEnvelope, type PaymentData } from '@/lib/encryption';

import { fetchUserSettings, patchUserSettings } from './api';
import {
  DEFAULT_AUTOPAY_LIMIT_DISPLAY,
  EMPTY_PAYMENT_DATA,
  EMPTY_SHIPPING_ADDRESS,
  GENERIC_SAVE_FAILURE_FALLBACK,
  NOT_AUTHENTICATED_MESSAGE,
} from './config';
import { buildPatchBody, parseInitialFetch } from './serialization';
import type { ShippingAddress, UseAgentPayModalResult, UserSettingsResponse } from './types';
import { validateForm } from './validation';

/**
 * Flat state snapshot returned by `useAgentPayFormState`. Grouping the
 * `useState` calls here keeps the main hook small enough to stay under the
 * strict 80-line function cap.
 */
interface AgentPayState {
  initialLoading: boolean;
  setInitialLoading: React.Dispatch<React.SetStateAction<boolean>>;
  savedEnvelope: EncryptedPaymentEnvelope | null;
  setSavedEnvelope: React.Dispatch<React.SetStateAction<EncryptedPaymentEnvelope | null>>;
  editingCard: boolean;
  setEditingCard: React.Dispatch<React.SetStateAction<boolean>>;
  paymentData: PaymentData;
  setPaymentData: React.Dispatch<React.SetStateAction<PaymentData>>;
  paymentErrors: Record<string, string>;
  setPaymentErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  autopayLimitDisplay: string;
  setAutopayLimitDisplay: React.Dispatch<React.SetStateAction<string>>;
  shippingAddress: ShippingAddress;
  setShippingAddress: React.Dispatch<React.SetStateAction<ShippingAddress>>;
  sameAsBilling: boolean;
  setSameAsBilling: React.Dispatch<React.SetStateAction<boolean>>;
  saving: boolean;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

const useAgentPayFormState = (): AgentPayState => {
  const [initialLoading, setInitialLoading] = useState(false);
  const [savedEnvelope, setSavedEnvelope] = useState<EncryptedPaymentEnvelope | null>(null);
  const [editingCard, setEditingCard] = useState(false);
  const [paymentData, setPaymentData] = useState<PaymentData>(EMPTY_PAYMENT_DATA);
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({});
  const [autopayLimitDisplay, setAutopayLimitDisplay] = useState(DEFAULT_AUTOPAY_LIMIT_DISPLAY);
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>(EMPTY_SHIPPING_ADDRESS);
  const [sameAsBilling, setSameAsBilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    initialLoading,
    setInitialLoading,
    savedEnvelope,
    setSavedEnvelope,
    editingCard,
    setEditingCard,
    paymentData,
    setPaymentData,
    paymentErrors,
    setPaymentErrors,
    autopayLimitDisplay,
    setAutopayLimitDisplay,
    shippingAddress,
    setShippingAddress,
    sameAsBilling,
    setSameAsBilling,
    saving,
    setSaving,
    error,
    setError,
  };
};

const applyInitialFetch = (state: AgentPayState, data: UserSettingsResponse): void => {
  const outcome = parseInitialFetch(data);
  state.setShippingAddress(outcome.shippingAddress);
  state.setSavedEnvelope(outcome.savedEnvelope);
  state.setEditingCard(outcome.editingCard);
  if (outcome.autopayLimitDisplay !== null) {
    state.setAutopayLimitDisplay(outcome.autopayLimitDisplay);
    if (outcome.savedEnvelope !== null) {
      const cents = outcome.savedEnvelope.autoagentpaylimit_cents;
      state.setPaymentData((prev) => ({ ...prev, autoagentpaylimit_cents: cents }));
    }
  }
};

const useInitialSettingsFetch = (isOpen: boolean, state: AgentPayState): void => {
  useEffect(() => {
    if (!isOpen) return;
    const run = async (): Promise<void> => {
      state.setInitialLoading(true);
      try {
        const session = getSession();
        const token = session?.access_token;
        if (token === undefined || token === '') return;
        const data = await fetchUserSettings(token);
        applyInitialFetch(state, data);
      } catch (err) {
        console.error('Failed to fetch user settings:', err);
      } finally {
        state.setInitialLoading(false);
      }
    };
    void run();
    // Deliberate: only re-run when `isOpen` flips. `state` is intentionally
    // omitted — including it would re-fire the effect every render because
    // `useAgentPayFormState` returns a fresh object literal each render, which
    // would loop the initial fetch (setInitialLoading(true) on every render).
    // The setters inside `state` are stable across renders per React's
    // `useState` contract, so depending only on `isOpen` is sound.
  }, [isOpen]);
};

interface InputHandlers {
  handleCardNumber: (value: string) => void;
  handleExpiry: (value: string) => void;
  handleCVV: (value: string) => void;
  handleAutopayBlur: () => void;
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]) => void;
  setShippingField: <K extends keyof ShippingAddress>(field: K, value: ShippingAddress[K]) => void;
}

const useInputHandlers = (state: AgentPayState): InputHandlers => ({
  handleCardNumber: (value: string): void => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
    state.setPaymentData((prev) => ({ ...prev, card_number: formatted }));
  },
  handleExpiry: (value: string): void => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    const formatted = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    state.setPaymentData((prev) => ({ ...prev, card_expiry: formatted }));
  },
  handleCVV: (value: string): void => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    state.setPaymentData((prev) => ({ ...prev, card_cvv: digits }));
  },
  handleAutopayBlur: (): void => {
    const dollars = parseFloat(state.autopayLimitDisplay) || 0;
    state.setPaymentData((prev) => ({
      ...prev,
      autoagentpaylimit_cents: Math.round(dollars * 100),
    }));
  },
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]): void => {
    state.setPaymentData((prev) => ({ ...prev, [field]: value }));
  },
  setShippingField: <K extends keyof ShippingAddress>(
    field: K,
    value: ShippingAddress[K]
  ): void => {
    state.setShippingAddress((prev) => ({ ...prev, [field]: value }));
  },
});

const buildHandleSave = (
  state: AgentPayState,
  showCardForm: boolean,
  onSuccess: () => void
): (() => Promise<void>) => {
  return async (): Promise<void> => {
    const errors = validateForm(
      state.paymentData,
      state.shippingAddress,
      showCardForm,
      state.sameAsBilling
    );
    state.setPaymentErrors(errors);
    if (Object.keys(errors).length > 0) return;
    state.setSaving(true);
    state.setError(null);
    try {
      const session = getSession();
      const token = session?.access_token;
      if (token === undefined || token === '') {
        state.setError(NOT_AUTHENTICATED_MESSAGE);
        state.setSaving(false);
        return;
      }
      const body = await buildPatchBody(
        state.paymentData,
        state.shippingAddress,
        state.autopayLimitDisplay,
        showCardForm,
        state.sameAsBilling
      );
      await patchUserSettings(token, body);
      onSuccess();
    } catch (err) {
      console.error('Failed to save agent pay:', err);
      state.setError(err instanceof Error ? err.message : GENERIC_SAVE_FAILURE_FALLBACK);
    } finally {
      state.setSaving(false);
    }
  };
};

const buildHandleClose = (state: AgentPayState, onClose: () => void): (() => void) => {
  return (): void => {
    if (state.saving) return;
    state.setPaymentData(EMPTY_PAYMENT_DATA);
    state.setPaymentErrors({});
    state.setAutopayLimitDisplay(DEFAULT_AUTOPAY_LIMIT_DISPLAY);
    state.setShippingAddress(EMPTY_SHIPPING_ADDRESS);
    state.setSameAsBilling(false);
    state.setSavedEnvelope(null);
    state.setEditingCard(false);
    state.setError(null);
    onClose();
  };
};

/**
 * All AgentPayModal state lives here. The component is a pure renderer over
 * this hook's result. Business rules encoded:
 *
 *   - Initial fetch: only runs when `isOpen` becomes true AND a session
 *     exists. GET 5xx / missing-session both fall through silently so the
 *     user can still fill the form. GET console-logs on failure.
 *   - Saved envelope (if present) hides the card form and surfaces a
 *     masked summary with an "Update" toggle.
 *   - Card number / expiry / CVV inputs strip non-digits and cap length
 *     before committing to state so later validation sees clean values.
 *   - Save path validates → (optionally) encrypts → PATCHes → onSuccess().
 *     5xx PATCH surfaces a friendly banner, does NOT close the modal, and
 *     re-enables the Save button for retry.
 *   - Close is a no-op while saving is in flight (to avoid closing mid-PATCH).
 *     On any other close path the full form + error state is reset so a
 *     later re-open starts from a clean slate.
 */
export const useAgentPayModal = (
  isOpen: boolean,
  onClose: () => void,
  onSuccess: () => void
): UseAgentPayModalResult => {
  const state = useAgentPayFormState();
  useInitialSettingsFetch(isOpen, state);
  const showCardForm = state.savedEnvelope === null || state.editingCard;
  const inputs = useInputHandlers(state);
  const handleSave = buildHandleSave(state, showCardForm, onSuccess);
  const handleClose = buildHandleClose(state, onClose);

  return {
    initialLoading: state.initialLoading,
    savedEnvelope: state.savedEnvelope,
    editingCard: state.editingCard,
    showCardForm,
    paymentData: state.paymentData,
    paymentErrors: state.paymentErrors,
    autopayLimitDisplay: state.autopayLimitDisplay,
    shippingAddress: state.shippingAddress,
    sameAsBilling: state.sameAsBilling,
    saving: state.saving,
    error: state.error,
    setEditingCard: state.setEditingCard,
    setAutopayLimitDisplay: state.setAutopayLimitDisplay,
    handleAutopayBlur: inputs.handleAutopayBlur,
    handleCardNumber: inputs.handleCardNumber,
    handleExpiry: inputs.handleExpiry,
    handleCVV: inputs.handleCVV,
    setPaymentField: inputs.setPaymentField,
    setShippingField: inputs.setShippingField,
    setSameAsBilling: state.setSameAsBilling,
    handleSave,
    handleClose,
  };
};
