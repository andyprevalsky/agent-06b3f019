export interface UserData {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
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

export type SettingsTab = 'customization' | 'info' | 'billing' | 'keys';

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
