import { useState, useEffect, useCallback } from 'react';
import { getStoredSession } from '@/lib/supabase';
import { type CustomizationData } from '@/features/customization';

import type { UserData, ApiKey, UpgradeOption } from '../types';
import { loadSettingsApi, loadSubscriptionApi, loadApiKeysApi } from '../api';

const EMPTY_USER_DATA: UserData = {
  name: '',
  email: '',
  phone: '',
  deliveryRecipientName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'United States',
};

function toUserData(data: Record<string, unknown>): UserData {
  return {
    name: (data.name as string) || '',
    email: (data.email as string) || '',
    phone: (data.phone as string) || '',
    deliveryRecipientName: (data.deliveryRecipientName as string) || '',
    addressLine1: (data.addressLine1 as string) || '',
    addressLine2: (data.addressLine2 as string) || '',
    city: (data.city as string) || '',
    state: (data.state as string) || '',
    postalCode: (data.postalCode as string) || '',
    country: (data.country as string) || 'United States',
  };
}

function useApiKeySettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);

  const loadApiKeys = useCallback(async () => {
    try {
      setLoadingKeys(true);
      if (!getStoredSession()) return;
      const data = (await loadApiKeysApi()) as { keys?: ApiKey[] };
      setApiKeys(data.keys ?? []);
    } catch {
      // API keys load failure is non-critical
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  return { apiKeys, loadingKeys, loadApiKeys };
}

export interface SettingsDataResult {
  loading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  userId: string | null;
  userData: UserData;
  setUserData: React.Dispatch<React.SetStateAction<UserData>>;
  customization: CustomizationData;
  setCustomization: React.Dispatch<React.SetStateAction<CustomizationData>>;
  subscriptionTier: number | null;
  upgradeOptions: UpgradeOption[];
  apiKeys: ApiKey[];
  loadingKeys: boolean;
  reloadApiKeys: () => Promise<void>;
}

/** Loads all settings data on mount: user settings, subscription, API keys. */
export function useSettingsData(): SettingsDataResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userData, setUserData] = useState<UserData>(EMPTY_USER_DATA);
  const [customization, setCustomization] = useState<CustomizationData>({
    systemName: 'Rose',
    profilePicture: null,
    customSystemPrompt: '',
  });
  const [subscriptionTier, setSubscriptionTier] = useState<number | null>(null);
  const [upgradeOptions, setUpgradeOptions] = useState<UpgradeOption[]>([]);
  const { apiKeys, loadingKeys, loadApiKeys } = useApiKeySettings();

  useEffect(() => {
    const session = getStoredSession();
    if (session?.user?.id) {
      setUserId(session.user.id);
    }

    const loadAll = async () => {
      try {
        setLoading(true);
        setError(null);
        const session2 = getStoredSession();
        if (!session2) {
          setError('Not authenticated');
          return;
        }
        const data = await loadSettingsApi();
        setUserData(toUserData(data));
        setCustomization({
          systemName: (data.systemName as string) || 'Rose',
          profilePicture: (data.profilePicture as string) || null,
          customSystemPrompt: (data.customSystemPrompt as string) || '',
        });
      } catch (err) {
        console.error('Failed to load settings:', err);
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };

    const loadSubscription = async () => {
      try {
        const session2 = getStoredSession();
        if (!session2) return;
        const data = (await loadSubscriptionApi()) as {
          tier?: number | null;
          upgradeOptions?: UpgradeOption[];
        };
        setSubscriptionTier(data.tier ?? null);
        setUpgradeOptions(data.upgradeOptions ?? []);
      } catch {
        // Subscription load failure is non-critical
      }
    };

    void loadAll();
    void loadSubscription();
    void loadApiKeys();
  }, [loadApiKeys]);

  return {
    loading,
    error,
    setError,
    userId,
    userData,
    setUserData,
    customization,
    setCustomization,
    subscriptionTier,
    upgradeOptions,
    apiKeys,
    loadingKeys,
    reloadApiKeys: loadApiKeys,
  };
}
