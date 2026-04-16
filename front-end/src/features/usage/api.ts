import { getStoredSession } from '@/lib/supabase';

import { type UsageData, type ModelStats } from './types';
import { API_URL } from './config';

/** Fetches credit usage and model stats from the backend. */
export async function fetchUsageData(): Promise<{
  usage: UsageData | null;
  topModels: ModelStats[];
  totalTokens: number;
}> {
  const session = getStoredSession();
  if (!session) {
    console.warn('No session');
    return { usage: null, topModels: [], totalTokens: 0 };
  }

  const headers = {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };

  const [usageResponse, statsResponse] = await Promise.all([
    fetch(`${API_URL}/api/credits/usage`, { headers }),
    fetch(`${API_URL}/api/credits/stats`, { headers }),
  ]);

  let usage: UsageData | null = null;
  let topModels: ModelStats[] = [];
  let totalTokens = 0;

  if (usageResponse.ok) {
    usage = (await usageResponse.json()) as UsageData;
  }
  if (statsResponse.ok) {
    const statsData = (await statsResponse.json()) as {
      totalTokens: number;
      topModels: ModelStats[];
    };
    totalTokens = statsData.totalTokens;
    topModels = statsData.topModels;
  }

  return { usage, topModels, totalTokens };
}
