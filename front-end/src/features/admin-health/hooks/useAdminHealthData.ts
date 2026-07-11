import { useEffect, useState } from 'react';

import { fetchAdminHealthData, readCachedAdminHealth } from '../api';
import type { AdminHealthData, AdminHealthTimeSlice } from '../types';

export function useAdminHealthData(timeSlice: AdminHealthTimeSlice) {
  const [data, setData] = useState<AdminHealthData | null>(() => readCachedAdminHealth(timeSlice));
  const [loading, setLoading] = useState(() => data === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const cached = readCachedAdminHealth(timeSlice);
    setData(cached);
    setLoading(cached === null);
    setError(null);

    fetchAdminHealthData(timeSlice)
      .then((result) => {
        if (!active) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [timeSlice]);

  return { data, loading, error };
}
