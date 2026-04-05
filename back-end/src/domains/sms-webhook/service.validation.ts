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
import type { ParsedSurgeMessage } from './types';
import { createLogger } from '../../providers/logger';

const log = createLogger('SMS Webhook');

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

/**
 * Extract phone number and body from Surge webhook payload.
 *
 * Surge message.received payload:
 * {
 *   id: "msg_...",
 *   body: "Hello",
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

  if (fromPhone === null || fromPhone === undefined || fromPhone === '' || messageBody === '') {
    return null;
  }

  return { fromPhone, messageBody };
}
