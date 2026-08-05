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
 * Start a REAL hosted Stripe Checkout for the selected items and return where to send the shopper.
 *
 * Used by the live fixtures, where the card is a live Rose-minted AgentCard: AgentCard refuses
 * `test_charge` on live cards ("Live cards are charged by real merchants") and Stripe blocks
 * live-mode raw-PAN tokenization, so the only way to authorize one is a real acquirer.
 */
export async function startTestPaymentCheckout(itemIds: string[]): Promise<{ url: string }> {
  const response = await fetch(`${TEST_PAYMENT_API_BASE}/checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: itemIds.map((id) => ({ id, quantity: 1 })) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to start checkout');
  return data as { url: string };
}

/** Reconcile a returned hosted Checkout onto the Rose purchase record. */
export async function settleTestPaymentCheckout(
  checkoutSessionId: string,
): Promise<TestPaymentConfirmation> {
  const response = await fetch(`${TEST_PAYMENT_API_BASE}/checkout-settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkoutSessionId }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to settle checkout');
  return data as TestPaymentConfirmation;
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
