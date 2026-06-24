import { API_BASE_WITH_PATH } from '@/lib/api/client';
import type { TestPaymentCardForm, TestPaymentConfirmation, TestPaymentItem } from './types';

const TEST_PAYMENT_API_BASE = import.meta.env.DEV
  ? '/api/test-payment'
  : `${API_BASE_WITH_PATH}/test-payment`;

export async function fetchTestPaymentItems(): Promise<TestPaymentItem[]> {
  const response = await fetch(`${TEST_PAYMENT_API_BASE}/items`);
  if (!response.ok) throw new Error('Failed to load test payment items');
  const data = (await response.json()) as { items: TestPaymentItem[] };
  return data.items;
}

/**
 * Returns this backend's live ngrok public URL (or null if no tunnel is up). Used by the
 * "Test Agent Debit Card" querybox prompt so the cloud browser agent gets a reachable URL.
 */
export async function fetchTestPaymentPublicUrl(): Promise<string | null> {
  try {
    const response = await fetch(`${TEST_PAYMENT_API_BASE}/public-url`);
    if (!response.ok) return null;
    const data = (await response.json()) as { url: string | null };
    return data.url ?? null;
  } catch {
    return null;
  }
}

export async function confirmTestPayment(
  itemIds: string[],
  card: TestPaymentCardForm,
): Promise<TestPaymentConfirmation> {
  const response = await fetch(`${TEST_PAYMENT_API_BASE}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: itemIds.map((id) => ({ id, quantity: 1 })),
      card,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to confirm test payment');
  }
  return data as TestPaymentConfirmation;
}
