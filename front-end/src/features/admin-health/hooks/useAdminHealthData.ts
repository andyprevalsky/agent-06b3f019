import { useEffect, useState } from 'react';

import { fetchAdminHealthData } from '../api';
import type { AdminHealthData, AdminHealthTimeSlice } from '../types';

export function useAdminHealthData(timeSlice: AdminHealthTimeSlice) {
  const [data, setData] = useState<AdminHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setLoading(true);
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
