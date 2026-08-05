import { useState, useCallback } from 'react';

import type { UserData } from '../types';
import { savePersonalInfoApi } from '../api';

interface SavePersonalInfoResult {
  saving: boolean;
  saved: boolean;
  saveSettings: () => Promise<void>;
}

/** Handles saving personal identity and delivery details. */
export function useSavePersonalInfo(
  userData: UserData,
  setError: (e: string | null) => void,
): SavePersonalInfoResult {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveSettings = useCallback(async () => {
    try {
      setSaving(true);
      setError(null);
      setSaved(false);
      await savePersonalInfoApi({
        name: userData.name,
        email: userData.email,
        deliveryRecipientName: userData.deliveryRecipientName,
        addressLine1: userData.addressLine1,
        addressLine2: userData.addressLine2,
        city: userData.city,
        state: userData.state,
        postalCode: userData.postalCode,
        country: userData.country,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [userData, setError]);

  return { saving, saved, saveSettings };
}
