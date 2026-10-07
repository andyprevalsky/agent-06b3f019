import { useState, useCallback, useEffect } from 'react';
import { type CustomizationData } from '@/features/customization';

import { saveCustomizationApi } from '../api';

interface SaveCustomizationResult {
  savingCustomization: boolean;
  savedCustomization: boolean;
  saveCustomization: () => Promise<void>;
}

/** Handles saving customization data (system name, prompt, profile pic). */
export function useSaveCustomization(
  customization: CustomizationData,
  setError: (e: string | null) => void,
): SaveCustomizationResult {
  const [savingCustomization, setSavingCustomization] = useState(false);
  const [savedCustomization, setSavedCustomization] = useState(false);

  useEffect(() => {
    if (!savedCustomization) return;
    const timer = setTimeout(() => setSavedCustomization(false), 3000);
    return () => clearTimeout(timer);
  }, [savedCustomization]);

  const saveCustomization = useCallback(async () => {
    try {
      setSavingCustomization(true);
      setError(null);
      setSavedCustomization(false);
      await saveCustomizationApi({
        systemName: customization.systemName || null,
        profilePicture: customization.profilePicture || null,
        customSystemPrompt: customization.customSystemPrompt || null,
      });
      setSavedCustomization(true);
    } catch (err) {
      console.error('Failed to save customization:', err);
      setError(err instanceof Error ? err.message : 'Failed to save customization');
    } finally {
      setSavingCustomization(false);
    }
  }, [customization, setError]);

  return { savingCustomization, savedCustomization, saveCustomization };
}
