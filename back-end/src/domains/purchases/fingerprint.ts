import { createHash } from 'node:crypto';

type StoredPurchaseIdentity = {
  userId: string;
  merchant: string;
  lineItemsJson: unknown;
  totalCents: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalizeReviewCount(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/(\p{Nd}),(?=\p{Nd})/gu, '$1') : value;
}

function canonicalizeLineItems(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((rawItem) => {
    const item = asRecord(rawItem);
    return item === null
      ? rawItem
      : { ...item, reviewCount: canonicalizeReviewCount(item.reviewCount) };
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])])
  );
}

function pythonAsciiJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
    .split('')
    .map((codeUnit) =>
      codeUnit.charCodeAt(0) >= 127
        ? `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`
        : codeUnit
    )
    .join('');
}

/**
 * Rebuild the agents-side canonical purchase fingerprint from a stored receipt.
 * This lets a canonical retry discover a live card whose pre-deploy row retained
 * any mixture of comma-formatted review counts, without enumerating aliases.
 */
export function canonicalStoredPurchaseFingerprint(input: StoredPurchaseIdentity): string | null {
  const receipt = asRecord(input.lineItemsJson);
  if (receipt === null) return null;
  const lineItems = canonicalizeLineItems(receipt.lineItems);
  if (lineItems === null) return null;

  const identity = {
    userId: input.userId,
    merchant: input.merchant.trim().toLowerCase(),
    currency: typeof receipt.currency === 'string' ? receipt.currency : 'USD',
    lineItems,
    fees: Array.isArray(receipt.fees) ? receipt.fees : [],
    totalCents: input.totalCents,
  };
  // Python's json.dumps defaults to ensure_ascii=True. Encode every UTF-16 code unit the same
  // way so fingerprints remain byte-identical across the agents and backend runtimes.
  const encoded = pythonAsciiJson(identity);
  return createHash('sha256').update(encoded).digest('hex');
}
