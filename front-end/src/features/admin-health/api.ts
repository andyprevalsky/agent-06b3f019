import { backendApiUrl } from '@/lib/backendUrl';
import { getStoredSession } from '@/lib/supabase';

import type { AdminHealthData, AdminHealthTimeSlice } from './types';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 'v4';
const REQUEST_TIMEOUT_MS = 15 * 1000;

function cacheKey(userId: string, timeSlice: AdminHealthTimeSlice): string {
  return `admin-health:${CACHE_VERSION}:${userId}:${timeSlice}`;
}

function sessionStore(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

export function readCachedAdminHealth(timeSlice: AdminHealthTimeSlice): AdminHealthData | null {
  try {
    const userId = getStoredSession()?.user.id;
    const store = sessionStore();
    if (!userId || store === null) return null;
    const key = cacheKey(userId, timeSlice);
    const raw = store.getItem(key);
    if (raw === null) return null;
    const cached = JSON.parse(raw) as { expiresAt?: number; data?: AdminHealthData };
    if (cached.expiresAt === undefined || cached.expiresAt <= Date.now() || !cached.data) {
      store.removeItem(key);
      return null;
    }
    return cached.data.timeSlice === timeSlice ? cached.data : null;
  } catch {
    return null;
  }
}

function writeCachedAdminHealth(
  userId: string,
  timeSlice: AdminHealthTimeSlice,
  data: AdminHealthData,
): void {
  try {
    sessionStore()?.setItem(
      cacheKey(userId, timeSlice),
      JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, data }),
    );
  } catch {
    // Caching is optional; a storage failure must not discard live data.
  }
}

export async function fetchAdminHealthData(
  timeSlice: AdminHealthTimeSlice,
): Promise<AdminHealthData> {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');
  const cached = readCachedAdminHealth(timeSlice);
  if (cached !== null) return cached;

  const params = new URLSearchParams({ timeSlice });
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${backendApiUrl()}/admin-health?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to load admin health (${response.status})`);
    }

    const data = (await response.json()) as AdminHealthData;
    writeCachedAdminHealth(session.user.id, timeSlice, data);
    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
