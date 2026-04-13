import { getStoredSession } from '@/lib/supabase';

import type { UsageData, ModelStats } from './types';

function getBackendUrl(): string {
  return (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
}

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

  const backendUrl = getBackendUrl();
  const headers = {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };

  const [usageResponse, statsResponse] = await Promise.all([
    fetch(`${backendUrl}/api/credits/usage`, { headers }),
    fetch(`${backendUrl}/api/credits/stats`, { headers }),
  ]);

  let usage: UsageData | null = null;
  let topModels: ModelStats[] = [];
  let totalTokens = 0;

  if (usageResponse.ok) {
    usage = await usageResponse.json();
  }
  if (statsResponse.ok) {
    const statsData = await statsResponse.json();
    totalTokens = statsData.totalTokens;
    topModels = statsData.topModels;
  }

  return { usage, topModels, totalTokens };
}
