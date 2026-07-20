/**
 * Write-lock / payment-approval SMS body formatting.
 *
 * Pure text rendering for the write_lock lifecycle event. Split out of
 * outboundEvents.ts (which owns the IO/notifier side) to keep each file under
 * the max-lines lint budget.
 *
 * Two sources feed the body:
 *   - requestPaymentCard: the normalized, ALWAYS-populated payment payload
 *     (agents/utils/payment_card.py). Preferred — carries merchant, per-item
 *     rating/reviews/line totals, subtotal/total in cents.
 *   - writeLockNotification: browser-extracted, frequently sparse. Fallback.
 *
 * Every rendered body appends the per-agent deep link (handled by the caller via
 * agentUrl) so the user can open the exact run from their phone.
 */

import { SMS_TEMPLATES } from '../smsTemplates';

interface WriteLockNotificationMedia {
  url?: unknown;
  alt?: unknown;
  kind?: unknown;
}

interface WriteLockNotificationItem {
  title?: unknown;
  price?: unknown;
  quantity?: unknown;
  description?: unknown;
  rating?: unknown;
  review_count?: unknown;
  image_url?: unknown;
}

interface WriteLockNotificationPurchase {
  items?: unknown;
  totals?: unknown;
}

interface WriteLockNotificationService {
  name?: unknown;
  domain?: unknown;
  url?: unknown;
}

export interface WriteLockNotification {
  trigger_type?: unknown;
  action?: unknown;
  service?: WriteLockNotificationService;
  media?: unknown;
  purchase?: WriteLockNotificationPurchase;
}

interface WriteLockMetadata {
  writeLockNotification?: WriteLockNotification | null;
  requestPaymentCard?: unknown;
}

/**
 * Normalized payment-card payload (agents/utils/payment_card.py
 * normalize_payment_payload). Unlike writeLockNotification (browser-extracted,
 * frequently sparse), this is guaranteed-populated on every payment approval —
 * so ratings/reviews/totals never silently drop from the SMS.
 */
interface PaymentCardLineItem {
  name?: unknown;
  imageUrl?: unknown;
  productUrl?: unknown;
  rating?: unknown;
  reviewCount?: unknown;
  unitPriceCents?: unknown;
  quantity?: unknown;
  lineTotalCents?: unknown;
}

interface PaymentCardFee {
  label?: unknown;
  amountCents?: unknown;
}

export interface PaymentCard {
  merchant?: unknown;
  currency?: unknown;
  lineItems?: unknown;
  fees?: unknown;
  subtotalCents?: unknown;
  totalCents?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function displayServiceName(service: WriteLockNotificationService | null): string {
  const name = asString(service?.name);
  if (name) {
    return name.replace(/\b(?:www\.)?([a-z0-9-]+)\.(?:com|co|net|org|io|ai)\b/gi, '$1');
  }

  const domain = asString(service?.domain);
  if (!domain) {
    return 'the site';
  }

  const withoutWww = domain.replace(/^www\./i, '');
  const label = withoutWww.split('.')[0] || withoutWww;
  return label ? label[0].toUpperCase() + label.slice(1) : 'the site';
}

export function sanitizeSmsText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '')
    .replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi, '')
    .replace(/\b([a-z0-9-]+)\.(?:com|co|net|org|io|ai)\b/gi, (_match, label: string) => {
      return label ? label[0].toUpperCase() + label.slice(1) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

export function getWriteLockNotification(metadata: unknown): WriteLockNotification | null {
  const metadataRecord = asRecord(metadata) as WriteLockMetadata | null;
  const notification = metadataRecord?.writeLockNotification ?? null;
  return asRecord(notification) as WriteLockNotification | null;
}

function getWriteLockItems(
  notification: WriteLockNotification | null
): WriteLockNotificationItem[] {
  const items = Array.isArray(notification?.purchase?.items) ? notification.purchase.items : [];
  return items
    .map((entry) => asRecord(entry) as WriteLockNotificationItem | null)
    .filter((entry): entry is WriteLockNotificationItem => entry !== null);
}

export function getWriteLockMediaUrl(notification: WriteLockNotification | null): string | null {
  const media = Array.isArray(notification?.media) ? notification.media : [];
  const firstImage = media
    .map((entry) => asRecord(entry) as WriteLockNotificationMedia | null)
    .find((entry) => asString(entry?.url) !== null);
  const mediaUrl = asString(firstImage?.url);
  if (mediaUrl) {
    return mediaUrl;
  }

  const firstItemImage = getWriteLockItems(notification)
    .map((item) => asString(item.image_url))
    .find((url) => url !== null);
  return firstItemImage ?? null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
  }
  return null;
}

function formatCents(value: unknown, currency: string): string | null {
  const cents = toNumber(value);
  if (cents === null || cents <= 0) {
    return null;
  }
  const amount = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

function formatRating(value: unknown): string | null {
  const asStr = asString(value);
  if (asStr) {
    return asStr;
  }
  const asNum = toNumber(value);
  return asNum !== null ? String(asNum) : null;
}

function formatReviewCount(value: unknown): string | null {
  const asStr = asString(value);
  if (asStr) {
    return asStr;
  }
  const asNum = toNumber(value);
  return asNum !== null ? asNum.toLocaleString('en-US') : null;
}

/**
 * Append the per-agent deep link AFTER sanitization so it survives
 * sanitizeSmsText's URL stripping (which exists to remove untrusted
 * merchant/product URLs). This is the one trusted link we intentionally keep.
 */
function appendAgentLink(body: string, agentUrl: string | null): string {
  if (!agentUrl) {
    return body;
  }
  return `${body}\n\nView agent: ${agentUrl}`;
}

export function getRequestPaymentCard(metadata: unknown): PaymentCard | null {
  const metadataRecord = asRecord(metadata) as WriteLockMetadata | null;
  return asRecord(metadataRecord?.requestPaymentCard) as PaymentCard | null;
}

function getPaymentCardItems(card: PaymentCard | null): PaymentCardLineItem[] {
  const items = Array.isArray(card?.lineItems) ? card.lineItems : [];
  return items
    .map((entry) => asRecord(entry) as PaymentCardLineItem | null)
    .filter((entry): entry is PaymentCardLineItem => entry !== null);
}

export function getPaymentCardMediaUrl(card: PaymentCard | null): string | null {
  for (const item of getPaymentCardItems(card)) {
    const imageUrl = asString(item.imageUrl);
    if (imageUrl) {
      return imageUrl;
    }
  }
  return null;
}

/**
 * Render the SMS body from the normalized requestPaymentCard payload. Guaranteed
 * to carry merchant, per-item rating/reviews/line totals, and subtotal/total —
 * the fields that silently dropped when we only read writeLockNotification.
 */
function formatPaymentCardBody(card: PaymentCard): string {
  const currency = asString(card.currency) ?? 'USD';
  const merchant = asString(card.merchant) ?? 'the merchant';
  const lines = [`Approval needed`, `Rose needs your approval for ${merchant} checkout.`];
  const items = getPaymentCardItems(card);

  if (items.length === 1) {
    const item = items[0];
    const name = asString(item.name);
    if (name) lines.push('', `Item: ${sanitizeSmsText(name)}`);
    const price =
      formatCents(item.lineTotalCents, currency) ?? formatCents(item.unitPriceCents, currency);
    if (price) lines.push(`Price: ${price}`);
    const quantity = toNumber(item.quantity);
    if (quantity !== null && quantity > 0) lines.push(`Qty: ${String(quantity)}`);
    const rating = formatRating(item.rating);
    if (rating) lines.push(`Rating: ${rating}`);
    const reviewCount = formatReviewCount(item.reviewCount);
    if (reviewCount) lines.push(`Reviews: ${reviewCount}`);
  } else if (items.length > 1) {
    lines.push('', `Items (${String(items.length)}):`);
    for (const [index, item] of items.slice(0, 6).entries()) {
      const name = sanitizeSmsText(asString(item.name) ?? `Item ${String(index + 1)}`);
      const price = formatCents(item.lineTotalCents, currency);
      const quantity = toNumber(item.quantity);
      lines.push(
        `${String(index + 1)}. ${name}${price ? ` - ${price}` : ''}${quantity && quantity > 1 ? ` x${String(quantity)}` : ''}`
      );
    }
    if (items.length > 6) {
      lines.push(`...and ${String(items.length - 6)} more`);
    }
  }

  const fees = Array.isArray(card.fees) ? card.fees : [];
  const subtotal = formatCents(card.subtotalCents, currency);
  const total = formatCents(card.totalCents, currency);
  const feeLines = fees
    .map((entry) => asRecord(entry) as PaymentCardFee | null)
    .map((fee) => {
      const amount = formatCents(fee?.amountCents, currency);
      if (!amount) return null;
      const label = asString(fee?.label) ?? 'Fee';
      return `${sanitizeSmsText(label)}: ${amount}`;
    })
    .filter((line): line is string => line !== null);

  if (subtotal || feeLines.length > 0 || total) {
    lines.push('');
    if (subtotal) lines.push(`Subtotal: ${subtotal}`);
    for (const feeLine of feeLines) lines.push(feeLine);
    if (total) lines.push(`Total: ${total}`);
  }

  return truncateText(lines.map((line) => sanitizeSmsText(line)).join('\n'), 900);
}

function formatWriteLockNotificationBody(
  notification: WriteLockNotification | null,
  fallbackQuestion: string
): string {
  if (!notification) {
    return SMS_TEMPLATES.writeLock('', fallbackQuestion);
  }

  const service = asRecord(notification.service) as WriteLockNotificationService | null;
  const serviceName = displayServiceName(service);
  const lines = [`Approval needed`, `Rose needs your approval for ${serviceName} checkout.`];
  const items = getWriteLockItems(notification);

  if (items.length === 1) {
    const item = items[0];
    const title = asString(item.title);
    if (title) lines.push('', `Item: ${sanitizeSmsText(title)}`);
    const price = asString(item.price);
    if (price) lines.push(`Price: ${price}`);
    const quantity = asString(item.quantity);
    if (quantity) lines.push(`Qty: ${quantity}`);
    const description = asString(item.description);
    if (description) {
      const sanitizedDescription = sanitizeSmsText(description);
      if (sanitizedDescription) {
        lines.push(`Description: ${sanitizedDescription}`);
      }
    }
    const rating = asString(item.rating);
    if (rating) lines.push(`Rating: ${rating}`);
    const reviewCount = asString(item.review_count);
    if (reviewCount) lines.push(`Reviews: ${reviewCount}`);
  } else if (items.length > 1) {
    lines.push('', `Items (${String(items.length)}):`);
    for (const [index, item] of items.slice(0, 6).entries()) {
      const title = sanitizeSmsText(asString(item.title) ?? `Item ${String(index + 1)}`);
      const price = asString(item.price);
      const quantity = asString(item.quantity);
      lines.push(
        `${String(index + 1)}. ${title}${price ? ` - ${price}` : ''}${quantity ? ` x${quantity}` : ''}`
      );
    }
    if (items.length > 6) {
      lines.push(`...and ${String(items.length - 6)} more`);
    }
  }

  const totals = asRecord(notification.purchase?.totals);
  const total = asString(totals?.total);
  const subtotal = asString(totals?.subtotal);
  const tax = asString(totals?.tax);
  if (subtotal || tax || total) {
    lines.push('');
    if (subtotal) lines.push(`Subtotal: ${subtotal}`);
    if (tax) lines.push(`Tax: ${tax}`);
    if (total) lines.push(`Total: ${total}`);
  }

  return truncateText(lines.map((line) => sanitizeSmsText(line)).join('\n'), 900);
}

/**
 * Build the payment-approval SMS body. Prefers the guaranteed-populated
 * requestPaymentCard payload, falls back to the browser-extracted
 * writeLockNotification, then to the plain question — always appending the
 * per-agent deep link so the user can open the exact run from their phone.
 */
export function formatPaymentApprovalBody(
  card: PaymentCard | null,
  notification: WriteLockNotification | null,
  fallbackQuestion: string,
  agentUrl: string | null
): string {
  if (card && getPaymentCardItems(card).length > 0) {
    return appendAgentLink(formatPaymentCardBody(card), agentUrl);
  }
  if (notification) {
    return appendAgentLink(
      formatWriteLockNotificationBody(notification, fallbackQuestion),
      agentUrl
    );
  }
  return appendAgentLink(SMS_TEMPLATES.writeLock('', fallbackQuestion), agentUrl);
}
