/**
 * Key-agnostic extraction of paid-order GMV from agent structured outputs.
 *
 * Requires BOTH:
 *   1. A USD amount (total_cents / checkout_total / amount / …)
 *   2. A confirmation / order id (order_id / confirmation_code / …)
 *
 * Approval-time write-locks and payment-boundary benches without a confirmation
 * id are intentionally rejected — they are not proof the order was paid.
 */

export interface StructuredGmvCapture {
  totalCents: number;
  confirmationId: string;
  merchant: string;
  amountKey: string;
  confirmationKey: string;
  sourceFields: Record<string, unknown>;
}

const CENTS_KEY_RE =
  /(total|amount|paid|charged|price|cost|subtotal|checkout|order|grand).*cents$|^cents$/i;
const AMOUNT_KEY_RE =
  /^(total|amount|price|cost|paid|charged)$|(checkout|order|cart|grand|final|purchase).*(total|amount|price)|(.*price.*usd)|(.*_total)$|(total_usd|amount_usd)$/i;
const CONFIRMATION_KEY_RE =
  /(order|payment|booking|reservation).*(id|number|confirmation)|(confirmation).*(id|code|number)|receipt_id|transaction_id/i;
const MERCHANT_KEY_RE = /^(merchant|vendor|seller|store|shop|restaurant|brand)$/i;
const NEGATIVE_COMPLETION_KEYS = new Set([
  'purchase_completed',
  'purchase_complete',
  'order_placed',
  'payment_completed',
  'paid',
]);

const INVALID_CONFIRMATION = new Set([
  '',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'unknown',
  'false',
  'true',
  '0',
  '-',
  'tbd',
  'pending',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function flattenEntries(
  value: unknown,
  prefix = '',
  out: Array<{ key: string; value: unknown }> = []
): Array<{ key: string; value: unknown }> {
  const record = asRecord(value);
  if (record === null) {
    if (prefix !== '') out.push({ key: prefix, value });
    return out;
  }
  for (const [key, child] of Object.entries(record)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const nested = asRecord(child);
    if (nested !== null) {
      flattenEntries(child, path, out);
    } else {
      out.push({ key: path, value: child });
    }
  }
  return out;
}

function leafKey(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? path;
}

function parseMoneyToCents(value: unknown, treatAsCents: boolean): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    // Keys ending in *_cents are integer cents; every other numeric field is USD.
    return treatAsCents ? Math.round(value) : Math.round(value * 100);
  }
  const text = String(value).trim();
  if (text === '') return null;
  if (treatAsCents && /^-?\d+$/.test(text)) {
    const cents = Number.parseInt(text, 10);
    return cents > 0 ? cents : null;
  }
  const match = text
    .replace(/\s+/g, '')
    .match(/(?:\$|USD)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/i);
  if (match === null) return null;
  const amount = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function normalizeConfirmation(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (text.length < 3) return null;
  if (INVALID_CONFIRMATION.has(text.toLowerCase())) return null;
  return text;
}

function hasExplicitNegativeCompletion(entries: Array<{ key: string; value: unknown }>): boolean {
  for (const { key, value } of entries) {
    if (!NEGATIVE_COMPLETION_KEYS.has(leafKey(key).toLowerCase())) continue;
    if (value === false || value === 'false' || value === 0 || value === '0') return true;
  }
  return false;
}

function scoreAmountKey(key: string): number {
  const leaf = leafKey(key).toLowerCase();
  if (leaf === 'total_cents' || leaf === 'totalcents') return 100;
  if (leaf.includes('checkout') && leaf.includes('total')) return 90;
  if (leaf.includes('order') && leaf.includes('total')) return 85;
  if (leaf === 'total' || leaf === 'amount') return 80;
  if (CENTS_KEY_RE.test(leaf)) return 70;
  if (AMOUNT_KEY_RE.test(leaf)) return 60;
  return 0;
}

function scoreConfirmationKey(key: string): number {
  const leaf = leafKey(key).toLowerCase();
  if (leaf === 'order_confirmation_id' || leaf === 'orderconfirmationid') return 100;
  if (leaf === 'confirmation_code' || leaf === 'confirmationcode') return 95;
  if (leaf === 'order_id' || leaf === 'orderid') return 90;
  if (leaf === 'order_number' || leaf === 'ordernumber') return 85;
  if (CONFIRMATION_KEY_RE.test(leaf)) return 70;
  return 0;
}

/**
 * Extract a paid-order GMV capture from any agent/browser structured_response.
 * Returns null unless both amount and confirmation id are present.
 */
export function extractStructuredGmv(structured: unknown): StructuredGmvCapture | null {
  const root = asRecord(structured);
  if (root === null) return null;
  const entries = flattenEntries(root);
  if (hasExplicitNegativeCompletion(entries)) return null;

  let bestAmount: { cents: number; key: string; score: number } | null = null;
  let bestConfirmation: { id: string; key: string; score: number } | null = null;
  let merchant = '';

  for (const { key, value } of entries) {
    const leaf = leafKey(key);
    if (MERCHANT_KEY_RE.test(leaf) && typeof value === 'string' && value.trim() !== '') {
      merchant = value.trim();
    }

    const amountScore = scoreAmountKey(key);
    if (amountScore > 0) {
      const treatAsCents = CENTS_KEY_RE.test(leaf);
      const cents = parseMoneyToCents(value, treatAsCents);
      if (cents !== null && (bestAmount === null || amountScore > bestAmount.score)) {
        bestAmount = { cents, key, score: amountScore };
      }
    }

    const confirmationScore = scoreConfirmationKey(key);
    if (confirmationScore > 0) {
      const id = normalizeConfirmation(value);
      if (id !== null && (bestConfirmation === null || confirmationScore > bestConfirmation.score)) {
        bestConfirmation = { id, key, score: confirmationScore };
      }
    }
  }

  if (bestAmount === null || bestConfirmation === null) return null;

  return {
    totalCents: bestAmount.cents,
    confirmationId: bestConfirmation.id,
    merchant: merchant === '' ? 'unknown merchant' : merchant,
    amountKey: bestAmount.key,
    confirmationKey: bestConfirmation.key,
    sourceFields: root,
  };
}
