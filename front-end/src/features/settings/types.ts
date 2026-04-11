import type { PaymentData, EncryptedPaymentEnvelope } from '@/lib/encryption';

export interface UserData {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  encryptedPaymentInformation: string | null;
}

export interface ApiKey {
  id: string;
  name: string | null;
  maskedApiKey: string;
  createdAt: string;
}

export interface UpgradeOption {
  tier: number;
  name: string;
  url: string;
}

export type SettingsTab = 'customization' | 'info' | 'payment' | 'billing' | 'keys';

export interface CustomizationState {
  systemName: string;
  profilePicture: string | null;
  customSystemPrompt: string;
}

export interface SettingsState {
  activeTab: SettingsTab;
  loading: boolean;
  error: string | null;
  userId: string | null;
  userData: UserData;
  customization: CustomizationState;
  saving: boolean;
  saved: boolean;
  savingCustomization: boolean;
  savedCustomization: boolean;
  showPaymentForm: boolean;
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  savingPayment: boolean;
  savedPayment: boolean;
  autopayLimitDisplay: string;
  savedPaymentEnvelope: EncryptedPaymentEnvelope | null;
  subscriptionTier: number | null;
  upgradeOptions: UpgradeOption[];
  loadingBillingPortal: boolean;
  apiKeys: ApiKey[];
  loadingKeys: boolean;
  generatingKey: boolean;
  newKeyName: string;
  showNewKeyForm: boolean;
  newlyGeneratedKey: string | null;
  showSubscriptionModal: boolean;
  deletingKeyId: string | null;
}
