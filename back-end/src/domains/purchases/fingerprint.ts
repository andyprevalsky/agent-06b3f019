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

function canonicalizeImageUrl(value: unknown): unknown {
  return typeof value === 'string'
    ? value.replace(/^http:\/\/placehold\.co(?=\/|$)/i, 'https://placehold.co')
    : value;
}

function asPositiveInt(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : 1;
  }
  return 1;
}

/**
 * Strip a trailing ` x{quantity}` or ` - x{quantity}` echo of the quantity field
 * so order-summary prose fingerprints the same as the product title.
 */
function canonicalizeLineItemName(
  name: unknown,
  quantity: unknown,
  unitPriceCents: unknown,
  merchant: string
): unknown {
  if (typeof name !== 'string') return name;
  const qty = asPositiveInt(quantity);
  const merchantEcho = /\s+(?:-\s*)?x(\d+)\s+\(([^()]*)\)\s*$/i.exec(name);
  if (
    merchantEcho !== null &&
    Number.parseInt(merchantEcho[1], 10) === qty &&
    merchantEcho[2].trim().toLowerCase() === merchant.trim().toLowerCase()
  ) {
    return name.slice(0, merchantEcho.index).trimEnd();
  }
  const cartSummary = /\s+-\s+x(\d+)\s+-\s+\$(\d+)\.(\d{2})(?:\s+\(([^()]*)\))?\s*$/i.exec(name);
  if (cartSummary !== null) {
    const echoedPrice =
      Number.parseInt(cartSummary[2], 10) * 100 + Number.parseInt(cartSummary[3], 10);
    const merchantLabel = merchant.trim().toLowerCase();
    const sourceLabel = (cartSummary[4] ?? '').trim().toLowerCase();
    if (
      Number.parseInt(cartSummary[1], 10) === qty &&
      echoedPrice === unitPriceCents &&
      (sourceLabel === '' ||
        sourceLabel === merchantLabel ||
        sourceLabel === `${merchantLabel} checkout`)
    ) {
      return name.slice(0, cartSummary.index).trimEnd();
    }
  }
  const priced = /\s+-\s+(\d+)\s+x\s+\$(\d+)\.(\d{2})\s*$/i.exec(name);
  if (
    priced !== null &&
    Number.parseInt(priced[1], 10) === qty &&
    Number.parseInt(priced[2], 10) * 100 + Number.parseInt(priced[3], 10) === unitPriceCents
  ) {
    return name.slice(0, priced.index).trimEnd();
  }
  const match = /\s+(?:-\s*)?x(\d+)\s*$/i.exec(name);
  if (match === null) return name;
  if (Number.parseInt(match[1], 10) !== qty) return name;
  return name.slice(0, match.index).trimEnd();
}

/** Browser extraction sometimes appends a product card's description to its title. */
function canonicalizeProductDescription(name: unknown, productUrl: unknown): unknown {
  if (typeof name !== 'string' || typeof productUrl !== 'string') return name;
  const separator = name.indexOf(' - ');
  if (separator < 0) return name;
  const title = name.slice(0, separator).trim();
  const description = name.slice(separator + 3).trim();
  // Keep short suffixes such as color and size variants distinct.
  if (description.split(/\s+/).length < 5) return name;
  let pathname: string;
  try {
    const url = new URL(productUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return name;
    pathname = url.pathname;
  } catch {
    return name;
  }
  const slug = /\/(?:p|products)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/i.exec(pathname)?.[1];
  if (slug === undefined || title.toLowerCase().replace(/\s+/g, '-') !== slug.toLowerCase()) {
    return name;
  }
  return title;
}

function canonicalizeLineItems(value: unknown, merchant: string): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((rawItem) => {
    const item = asRecord(rawItem);
    return item === null
      ? rawItem
      : {
          ...item,
          name: canonicalizeProductDescription(
            canonicalizeLineItemName(item.name, item.quantity, item.unitPriceCents, merchant),
            item.productUrl
          ),
          imageUrl: canonicalizeImageUrl(item.imageUrl),
          reviewCount: canonicalizeReviewCount(item.reviewCount),
        };
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
  const lineItems = canonicalizeLineItems(receipt.lineItems, input.merchant);
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
