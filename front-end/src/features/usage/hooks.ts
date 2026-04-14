import { useEffect, useState } from 'react';

import { type UsageData, type ModelStats } from './types';
import { fetchUsageData } from './api';

/** Fetches and manages usage data state. */
export function useUsageData() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [topModels, setTopModels] = useState<ModelStats[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsageData()
      .then((data) => {
        setUsage(data.usage);
        setTopModels(data.topModels);
        setTotalTokens(data.totalTokens);
      })
      .catch((error) => {
        console.error('Error fetching usage:', error);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return { usage, topModels, totalTokens, loading } as const;
}
