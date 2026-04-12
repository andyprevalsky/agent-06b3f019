import { useState, useCallback } from 'react';

import type { UpgradeOption } from '../types';
import { openBillingPortalApi } from '../api';

interface BillingResult {
  loadingBillingPortal: boolean;
  openBillingPortal: () => Promise<void>;
  getSubscribeUrl: () => string | null;
}

/** Manages billing portal and subscription URL generation. */
export function useBilling(
  userId: string | null,
  upgradeOptions: UpgradeOption[],
  setError: (e: string | null) => void,
): BillingResult {
  const [loadingBillingPortal, setLoadingBillingPortal] = useState(false);

  const openBillingPortal = useCallback(async () => {
    try {
      setLoadingBillingPortal(true);
      const result = await openBillingPortalApi();
      if (result.notFound) {
        setError(result.message ?? 'Subscription required');
        return;
      }
      window.open(result.url, '_blank');
    } catch (err) {
      console.error('Failed to open billing portal:', err);
      setError(err instanceof Error ? err.message : 'Failed to open billing portal');
    } finally {
      setLoadingBillingPortal(false);
    }
  }, [setError]);

  const getSubscribeUrl = useCallback(() => {
    if (upgradeOptions.length > 0 && userId) {
      return `${upgradeOptions[0].url}?client_reference_id=${userId}`;
    }
    return null;
  }, [upgradeOptions, userId]);

  return { loadingBillingPortal, openBillingPortal, getSubscribeUrl };
}
