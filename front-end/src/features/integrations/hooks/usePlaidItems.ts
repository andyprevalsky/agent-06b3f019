/**
 * STATE MACHINE: usePlaidItems
 *
 *   [LOADING] --refresh--> [LOADED] (or [ERROR])
 *   [LOADED]  --refresh--> [LOADING] (in-place refresh)
 */

import { useCallback, useEffect, useState } from 'react';

import { listPlaidItemsApi } from '../api';
import type { PlaidItem } from '../types';

export function usePlaidItems(): {
  items: PlaidItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [items, setItems] = useState<PlaidItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await listPlaidItemsApi();
      setItems(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Plaid items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, error, refresh };
}
