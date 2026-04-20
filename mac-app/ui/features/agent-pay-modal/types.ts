/**
 * Types for the agent-pay-modal feature.
 *
 * Props cross the feature boundary (parent passes callbacks + open flag).
 * The hook-result, form-state, and api-shape types are feature-internal —
 * exported so the sub-components and api/hook layers can share them.
 */

import type { PaymentData, EncryptedPaymentEnvelope } from '@/lib/encryption';

export interface AgentPayModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export interface ShippingAddress {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Shape of the GET /api/user-settings response consumed by the modal. Only
 * the fields we actually read are listed — the backend may return more and
 * that's fine.
 */
export interface UserSettingsResponse {
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  encryptedPaymentInformation?: string;
}

/**
 * Shape of the PATCH /api/user-settings body sent by the modal. All fields
 * optional — the modal omits `encryptedPaymentInformation` when the saved
 * card was kept untouched.
 */
export interface UserSettingsPatchBody {
  encryptedPaymentInformation?: string;
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Full result of the `useAgentPayModal` hook. All derived state + handlers
 * the renderer needs to draw the modal in its current state.
 */
export interface UseAgentPayModalResult {
  // Loading / saved-card state
  initialLoading: boolean;
  savedEnvelope: EncryptedPaymentEnvelope | null;
  editingCard: boolean;
  showCardForm: boolean;

  // Form state
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  autopayLimitDisplay: string;
  shippingAddress: ShippingAddress;
  sameAsBilling: boolean;

  // Submission state
  saving: boolean;
  error: string | null;

  // Setters / handlers
  setEditingCard: (value: boolean) => void;
  setAutopayLimitDisplay: (value: string) => void;
  handleAutopayBlur: () => void;
  handleCardNumber: (value: string) => void;
  handleExpiry: (value: string) => void;
  handleCVV: (value: string) => void;
  setPaymentField: <K extends keyof PaymentData>(field: K, value: PaymentData[K]) => void;
  setShippingField: <K extends keyof ShippingAddress>(field: K, value: ShippingAddress[K]) => void;
  setSameAsBilling: (value: boolean) => void;
  handleSave: () => Promise<void>;
  handleClose: () => void;
}
