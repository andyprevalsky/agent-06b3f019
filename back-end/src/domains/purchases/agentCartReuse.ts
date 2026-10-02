/**
 * Same-agent held-card lookup keyed on a cart's priced structure.
 *
 * Line-item names, product URLs, and review text are written by the browser model and drift
 * between two requests for one cart ("Aurora Notebook" vs "Aurora Notebook (x1)"), so the content
 * fingerprint misses and a second card would be minted — a second Stripe hold for the same order.
 * Within one agent, a HELD card for the same merchant, currency, total, fee amounts, and per-item
 * unit price × quantity = line total is that order. The match never crosses agents, so it cannot
 * widen the user-level auto-approve cache, and every request still shows its own approval prompt.
 */
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import type { MintPurchaseInput, PurchaseSpend } from './types';

const log = createLogger('Purchases');
const MAX_CANDIDATES = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCents(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function itemSignature(rawItem: unknown): string | null {
  const item = asRecord(rawItem);
  if (item === null) return null;
  const unit = asCents(item.unitPriceCents);
  const quantity = asCents(item.quantity);
  const line = asCents(item.lineTotalCents);
  if (unit === null || quantity === null || quantity === 0 || line === null) return null;
  return `${unit}x${quantity}=${line}`;
}

/** Price-only identity of a stored or requested receipt; null when any amount is missing. */
export function cartPriceSignature(receiptJson: unknown, totalCents: number): string | null {
  const receipt = asRecord(receiptJson);
  if (receipt === null || !Array.isArray(receipt.lineItems) || receipt.lineItems.length === 0) {
    return null;
  }
  const items: string[] = [];
  for (const rawItem of receipt.lineItems) {
    const signature = itemSignature(rawItem);
    if (signature === null) return null;
    items.push(signature);
  }
  const fees: number[] = [];
  for (const rawFee of Array.isArray(receipt.fees) ? receipt.fees : []) {
    const amount = asCents(asRecord(rawFee)?.amountCents);
    if (amount === null) return null;
    fees.push(amount);
  }
  const currency =
    typeof receipt.currency === 'string' ? receipt.currency.trim().toUpperCase() : '';
  return JSON.stringify({
    currency: currency === '' ? 'USD' : currency,
    totalCents,
    items: items.sort(),
    fees: fees.sort((a, b) => a - b),
  });
}

export async function findSameAgentHeldCart(
  input: MintPurchaseInput,
  since: Date
): Promise<PurchaseSpend | null> {
  const agentId = input.agentId?.trim() ?? '';
  if (agentId === '') return null;
  const wanted = cartPriceSignature(input, input.totalCents);
  if (wanted === null) return null;
  const candidates = await repo.findHeldPurchasesForAgentCart({
    userId: input.userId,
    agentId,
    merchant: input.merchant.trim(),
    totalCents: input.totalCents,
    since,
    take: MAX_CANDIDATES,
  });
  const held =
    candidates.find(
      (candidate) => cartPriceSignature(candidate.lineItemsJson, candidate.totalCents) === wanted
    ) ?? null;
  log.info('Same-agent held cart lookup', {
    agent_id: agentId,
    candidates: candidates.length,
    purchase_id: held?.id,
    requested_fingerprint: input.fingerprint,
    held_fingerprint: held?.fingerprint,
  });
  return held;
}
