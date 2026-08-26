import { getStoredSession } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api/client';

function getAuthHeaders(): Record<string, string> {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

/** Mint a fresh Stripe subscription checkout URL (optionally returning to this page). */
export async function startSubscriptionCheckoutApi(returnUrl?: string): Promise<{ url: string }> {
  const response = await fetch(`${API_BASE_URL}/api/billing/subscription-checkout`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: returnUrl ? JSON.stringify({ returnUrl }) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !payload?.url) {
    throw new Error(payload?.error || 'Failed to start subscription checkout');
  }
  return { url: payload.url };
}
