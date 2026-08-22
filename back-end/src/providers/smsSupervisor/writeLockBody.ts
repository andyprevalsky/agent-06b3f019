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

interface WriteLockMessageDetails {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
}

interface WriteLockSocialPostDetails {
  destination?: unknown;
  audience?: unknown;
  body?: unknown;
}

interface WriteLockPaymentDetails {
  merchant?: unknown;
  amount?: unknown;
  purpose?: unknown;
  fields?: unknown;
}

interface WriteLockGenericWriteDetails {
  label?: unknown;
  target?: unknown;
  payload_summary?: unknown;
}

export interface WriteLockNotification {
  trigger_type?: unknown;
  action?: unknown;
  service?: WriteLockNotificationService;
  media?: unknown;
  purchase?: WriteLockNotificationPurchase;
  message?: WriteLockMessageDetails;
  social_post?: WriteLockSocialPostDetails;
  payment?: WriteLockPaymentDetails;
  generic_write?: WriteLockGenericWriteDetails;
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

/**
 * SMS/iMessage does not render Markdown. Convert emphasis markers to plain
 * text so approval SMS never shows literal `**Email**` / `**To:**` asterisks.
 * Keep the inner label text; leave unpaired asterisks in prose alone.
 */
export function stripMarkdownForSms(value: string): string {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2');
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
  // Preserve email addresses — the domain→label rewrite would turn
  // alex@example.com into alex@Example and break approval copy.
  // U+0001 cannot appear in notification payloads, so page content cannot forge
  // a placeholder and hijack restore (unlike a textual `__EMAIL_n__` token).
  const emailSentinel = String.fromCharCode(1);
  const emails: string[] = [];
  const withEmailPlaceholders = value.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    (match) => {
      emails.push(match);
      return emailSentinel;
    }
  );

  const cleaned = withEmailPlaceholders
    .replace(/https?:\/\/[^\s)]+/gi, '')
    .replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi, '')
    .replace(/\b([a-z0-9-]+)\.(?:com|co|net|org|io|ai)\b/gi, (_match, label: string) => {
      return label ? label[0].toUpperCase() + label.slice(1) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

  // Restore by position (split keeps empty segments when the sentinel is adjacent).
  let cursor = 0;
  return cleaned
    .split(emailSentinel)
    .map((part, index) => {
      if (index === 0) {
        return part;
      }
      return `${emails[cursor++] ?? ''}${part}`;
    })
    .join('');
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

function sentenceCaseAction(action: string): string {
  if (!action) {
    return action;
  }
  if (
    action.length >= 2 &&
    action[0] === action[0].toUpperCase() &&
    action[1] === action[1].toUpperCase()
  ) {
    return action;
  }
  return action[0].toLowerCase() + action.slice(1);
}

function pushLabeledValue(lines: string[], label: string, value: unknown): void {
  const text = asString(value);
  if (!text) {
    return;
  }
  lines.push(`${label}: ${text}`);
}

function formatRecipientList(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return asString(value);
  }
  const recipients = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== null);
  return recipients.length > 0 ? recipients.join(', ') : null;
}

function appendPurchaseSmsLines(lines: string[], notification: WriteLockNotification): number {
  const before = lines.length;
  const items = getWriteLockItems(notification);

  if (items.length === 1) {
    const item = items[0];
    const title = asString(item.title);
    if (title) lines.push('', `Item: ${sanitizeSmsText(title)}`);
    pushLabeledValue(lines, 'Price', item.price);
    pushLabeledValue(lines, 'Qty', item.quantity);
    const description = asString(item.description);
    if (description) {
      const sanitizedDescription = sanitizeSmsText(description);
      if (sanitizedDescription) {
        lines.push(`Description: ${sanitizedDescription}`);
      }
    }
    pushLabeledValue(lines, 'Rating', formatRating(item.rating));
    pushLabeledValue(lines, 'Reviews', formatReviewCount(item.review_count));
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

  const purchase = asRecord(notification.purchase);
  pushLabeledValue(lines, 'Payment', purchase?.payment_method);
  pushLabeledValue(lines, 'Delivery', purchase?.delivery_address);

  return lines.length - before;
}

function appendMessageSmsLines(lines: string[], message: Record<string, unknown> | null): number {
  if (!message) {
    return 0;
  }
  const before = lines.length;
  for (const [label, key] of [
    ['To', 'to'],
    ['Cc', 'cc'],
    ['Bcc', 'bcc'],
  ] as const) {
    const recipients = formatRecipientList(message[key]);
    if (recipients) {
      lines.push(`${label}: ${recipients}`);
    }
  }
  pushLabeledValue(lines, 'Subject', message.subject);
  const body = asString(message.body);
  if (body) {
    lines.push('', 'Body:', body);
  }
  return lines.length - before;
}

function appendSocialPostSmsLines(
  lines: string[],
  socialPost: Record<string, unknown> | null
): number {
  if (!socialPost) {
    return 0;
  }
  const before = lines.length;
  pushLabeledValue(lines, 'Destination', socialPost.destination);
  pushLabeledValue(lines, 'Audience', socialPost.audience);
  const body = asString(socialPost.body);
  if (body) {
    lines.push('', 'Post:', body);
  }
  return lines.length - before;
}

function appendPaymentSmsLines(lines: string[], payment: Record<string, unknown> | null): number {
  if (!payment) {
    return 0;
  }
  const before = lines.length;
  pushLabeledValue(lines, 'Merchant', payment.merchant);
  pushLabeledValue(lines, 'Amount', payment.amount);
  pushLabeledValue(lines, 'Purpose', payment.purpose);
  if (Array.isArray(payment.fields) && payment.fields.length > 0) {
    const fields = payment.fields
      .map((entry) => asString(entry))
      .filter((entry): entry is string => entry !== null);
    if (fields.length > 0) {
      lines.push(`Fields: ${fields.join(', ')}`);
    }
  }
  if (lines.length > before) {
    lines.push('', 'Payment secrets are not included in this message.');
  }
  return lines.length - before;
}

function appendGenericWriteSmsLines(
  lines: string[],
  genericWrite: Record<string, unknown> | null
): number {
  if (!genericWrite) {
    return 0;
  }
  const before = lines.length;
  pushLabeledValue(lines, 'Action', genericWrite.label);
  pushLabeledValue(lines, 'Target', genericWrite.target);
  pushLabeledValue(lines, 'Change', genericWrite.payload_summary);
  return lines.length - before;
}

/**
 * Render SMS from structured writeLockNotification for every trigger_type.
 * Purchase keeps the carrier-safe "checkout" header; other triggers use the
 * action-based header that matches the in-app approval renderer. Falls back to
 * the rendered approval question when structured details are missing.
 */
function formatWriteLockNotificationBody(
  notification: WriteLockNotification | null,
  fallbackQuestion: string
): string {
  if (!notification) {
    return SMS_TEMPLATES.writeLock('', stripMarkdownForSms(fallbackQuestion));
  }

  const triggerType = asString(notification.trigger_type) ?? 'purchase';
  const service = asRecord(notification.service) as WriteLockNotificationService | null;
  const serviceName = displayServiceName(service);
  const action = asString(notification.action) ?? 'perform a write action';

  const lines: string[] =
    triggerType === 'purchase'
      ? [`Approval needed`, `Rose needs your approval for ${serviceName} checkout.`]
      : [`Approval needed`, `Rose wants to ${sentenceCaseAction(action)} on ${serviceName}.`];

  let detailCount = 0;
  if (triggerType === 'purchase') {
    detailCount = appendPurchaseSmsLines(lines, notification);
  } else if (triggerType === 'message') {
    detailCount = appendMessageSmsLines(lines, asRecord(notification.message));
  } else if (triggerType === 'social_post') {
    detailCount = appendSocialPostSmsLines(lines, asRecord(notification.social_post));
  } else if (triggerType === 'payment') {
    detailCount = appendPaymentSmsLines(lines, asRecord(notification.payment));
  } else if (triggerType === 'generic_write') {
    detailCount = appendGenericWriteSmsLines(lines, asRecord(notification.generic_write));
  }

  if (detailCount === 0) {
    // Sparse / unknown trigger — prefer the already-rendered approval question
    // so SMS still carries the key facts instead of a hollow "checkout" stub.
    return SMS_TEMPLATES.writeLock('', stripMarkdownForSms(fallbackQuestion));
  }

  const body = lines.map((line) => sanitizeSmsText(line)).join('\n');
  // Message / social / return bodies are the content being approved — do not
  // apply the purchase 900-char truncate budget (same rule as plain-question path).
  if (
    triggerType === 'message' ||
    triggerType === 'social_post' ||
    triggerType === 'generic_write'
  ) {
    return body;
  }
  return truncateText(body, 900);
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
  // Tool-approval questions (message_person, browser write locks) often carry
  // Markdown labels meant for the web UI. Strip them at the SMS sink so iMessage
  // never shows literal asterisks. Payment-card / structured bodies are already
  // plain text.
  const plainQuestion = stripMarkdownForSms(fallbackQuestion);
  if (card && getPaymentCardItems(card).length > 0) {
    return appendAgentLink(formatPaymentCardBody(card), agentUrl);
  }
  if (notification) {
    return appendAgentLink(formatWriteLockNotificationBody(notification, plainQuestion), agentUrl);
  }
  // Natural-language tool approvals must keep the full draft — never apply the
  // 900-char payment-card truncate budget to the message the user is approving.
  return appendAgentLink(SMS_TEMPLATES.writeLock('', plainQuestion), agentUrl);
}
