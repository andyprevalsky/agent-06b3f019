/**
 * SMS Webhook Validation & Parsing
 *
 * Pure functions for Surge signature validation and payload parsing.
 * No side effects, no state.
 *
 * Surge signature: Surge-Signature header with HMAC-SHA256
 *   Format: "t=<timestamp>,v1=<hmac>"
 *   Signed payload: "<timestamp>.<raw_body>"
 */

import { createHmac, timingSafeEqual } from '../../providers/crypto';
import type { ParsedSurgeMessage, SurgeAttachment } from './types';
import { createLogger } from '../../providers/logger';

const log = createLogger('SMS Webhook');

/* c8 ignore start -- validateSurgeSignature only called when IS_PRODUCTION is true (skipped in test env) */
/**
 * Validate Surge webhook signature (HMAC-SHA256)
 *
 * Surge sends: Surge-Signature: t=<timestamp>,v1=<hmac>
 * Signed payload: "<timestamp>.<raw_json_body>"
 */
export function validateSurgeSignature(
  signatureHeader: string | undefined,
  rawBody: string,
  signingSecret: string
): boolean {
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader === '') {
    return false;
  }

  // Parse "t=1737830031,v1=abc123..."
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(',')) {
    const [key, ...valueParts] = part.split('=');
    parts[key] = valueParts.join('=');
  }

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (timestamp === undefined || timestamp === '' || signature === undefined || signature === '') {
    return false;
  }

  // Reject if timestamp is older than 5 minutes
  const parsedTimestamp = parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTimestamp)) {
    log.warn('Surge signature has invalid timestamp', { timestamp });
    return false;
  }
  const timestampAge = Math.abs(Date.now() / 1000 - parsedTimestamp);
  if (timestampAge > 300) {
    log.warn('Surge signature too old', { timestampAge });
    return false;
  }

  // Reconstruct signed payload: "<timestamp>.<raw_body>"
  const signedPayload = `${timestamp}.${rawBody}`;

  const hmac = createHmac('sha256', signingSecret);
  hmac.update(signedPayload, 'utf-8');
  const expectedSignature = hmac.digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(sigBuffer, expectedBuffer);
}
/* c8 ignore stop */

/**
 * Extract phone number, body, and media attachments from Surge webhook payload.
 *
 * Surge message.received payload:
 * {
 *   id: "msg_...",
 *   body: "Hello",
 *   attachments: [{ id: "att_...", type: "image/jpeg", url: "https://..." }],
 *   conversation: {
 *     contact: { phone_number: "+19729777432", ... },
 *     phone_number: { number: "+18001234567", ... }
 *   }
 * }
 */
export function parseSurgePayload(body: Record<string, unknown>): ParsedSurgeMessage | null {
  // Surge wraps the message under a `data` envelope
  const data = (body?.data as Record<string, unknown> | undefined) ?? body;
  const messageBody = String(data?.body ?? '').trim();
  const conversation = data?.conversation as Record<string, unknown> | undefined;
  const contact = conversation?.contact as Record<string, unknown> | undefined;
  const fromPhone = contact?.phone_number as string | undefined;
  const attachments = parseSurgeAttachments(data);

  // A message must carry text or at least one attachment (media-only MMS has
  // an empty body — dropping those silently loses photos and voice notes).
  if (
    fromPhone === null ||
    fromPhone === undefined ||
    fromPhone === '' ||
    (messageBody === '' && attachments.length === 0)
  ) {
    return null;
  }

  return { fromPhone, messageBody, attachments };
}

function parseSurgeAttachments(data: Record<string, unknown> | undefined): SurgeAttachment[] {
  const raw = data?.attachments;
  if (!Array.isArray(raw)) return [];

  const attachments: SurgeAttachment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.url !== 'string' || entry.url === '') continue;
    // Surge uses `type`; tolerate `content_type` in case of payload drift.
    const hint = entry.type ?? entry.content_type;
    attachments.push({
      url: entry.url,
      type: typeof hint === 'string' && hint !== '' ? hint : null,
    });
  }
  return attachments;
}
