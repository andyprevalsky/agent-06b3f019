import { backendApiUrl } from '@/lib/backendUrl';
import { getItem, removeItem, setItem } from '@/lib/storage';
import { getStoredSession } from '@/lib/supabase';

import type { AdminHealthData, AdminHealthTimeSlice } from './types';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 'v4';

function cacheKey(timeSlice: AdminHealthTimeSlice): string {
  return `admin-health:${CACHE_VERSION}:${timeSlice}`;
}

export function readCachedAdminHealth(timeSlice: AdminHealthTimeSlice): AdminHealthData | null {
  try {
    const raw = getItem(cacheKey(timeSlice));
    if (raw === null) return null;
    const cached = JSON.parse(raw) as { expiresAt?: number; data?: AdminHealthData };
    if (cached.expiresAt === undefined || cached.expiresAt <= Date.now() || !cached.data) {
      removeItem(cacheKey(timeSlice));
      return null;
    }
    return cached.data.timeSlice === timeSlice ? cached.data : null;
  } catch {
    return null;
  }
}

function writeCachedAdminHealth(timeSlice: AdminHealthTimeSlice, data: AdminHealthData): void {
  setItem(cacheKey(timeSlice), JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, data }));
}

export async function fetchAdminHealthData(
  timeSlice: AdminHealthTimeSlice,
): Promise<AdminHealthData> {
  const cached = readCachedAdminHealth(timeSlice);
  if (cached !== null) return cached;
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');

  const params = new URLSearchParams({ timeSlice });
  const response = await fetch(`${backendApiUrl()}/admin-health?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load admin health (${response.status})`);
  }

  const data = (await response.json()) as AdminHealthData;
  writeCachedAdminHealth(timeSlice, data);
  return data;
}
