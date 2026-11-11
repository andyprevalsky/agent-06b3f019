import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LinqSignatureHeaders, ParsedLinqMessage } from './types';

function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 &&
    bytes.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')
    ? bytes
    : null;
}

/** Standard Webhooks: authenticate the exact bytes, with a symmetric five-minute replay window. */
export function validateLinqSignature(
  headers: LinqSignatureHeaders,
  rawBody: Buffer | string | undefined,
  secret: string | undefined,
  nowMs: number = Date.now()
): boolean {
  const { id, timestamp, signature } = headers;
  if (
    secret === undefined ||
    secret === '' ||
    rawBody === undefined ||
    id === undefined ||
    id === '' ||
    timestamp === undefined ||
    timestamp === '' ||
    signature === undefined ||
    signature === ''
  )
    return false;
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(nowMs)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(nowMs / 1000 - seconds) > 300) return false;
  const key = decodeBase64(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  if (!key) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return signature.split(/\s+/).some((candidate) => {
    if (!candidate.startsWith('v1,')) return false;
    const actual = decodeBase64(candidate.slice(3));
    return (
      actual !== null && actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Only phone handles prove phone ownership; an iMessage email must never create a phone account. */
function phone(value: unknown): string | null {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value) ? value : null;
}

/** Returns null for unsupported, unowned, group, outbound, empty, or malformed events. */
export function parseLinqPayload(
  body: unknown,
  configuredPhone: string | undefined
): ParsedLinqMessage | null {
  const envelope = record(body);
  const ownerPhone = phone(configuredPhone);
  if (!envelope || ownerPhone === null || envelope.event_type !== 'message.received') return null;
  const data = record(envelope.data);
  if (!data) return null;
  const version = envelope.webhook_version;
  if (version !== undefined && version !== '2026-02-03' && version !== '2025-01-01') return null;
  const modern = version === '2026-02-03' || (version === undefined && data.chat !== undefined);
  const chat = record(data.chat);
  const message = modern ? data : record(data.message);
  const owner = record(modern ? chat?.owner_handle : data.recipient_handle);
  const sender = record(modern ? data.sender_handle : data.from_handle);
  if (!message || !sender) return null;
  // Never fall back to legacy identity fields when a modern payload is incomplete.
  const recipient = modern ? owner?.handle : (owner?.handle ?? data.recipient_phone);
  if (phone(recipient) !== ownerPhone || owner?.is_me === false) return null;
  if (
    modern
      ? chat?.is_group !== false || data.direction !== 'inbound'
      : data.is_group !== false || data.is_from_me !== false
  )
    return null;
  if (sender.is_me !== false) return null;
  const fromPhone = phone(sender.handle);
  const chatId = nonempty(modern ? chat?.id : data.chat_id);
  const messageId = nonempty(message.id);
  const service = data.service;
  if (fromPhone === null || fromPhone === ownerPhone || chatId === null || messageId === null)
    return null;
  if (service !== 'iMessage' && service !== 'SMS' && service !== 'RCS') return null;
  if (!Array.isArray(message.parts)) return null;
  const text: string[] = [];
  const attachments: ParsedLinqMessage['attachments'] = [];
  for (const part of message.parts) {
    const item = record(part);
    if (!item) continue;
    if (item.type === 'text' && typeof item.value === 'string') text.push(item.value);
    if (item.type === 'media' && typeof item.url === 'string') {
      try {
        const url = new URL(item.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          attachments.push({ url: item.url, type: nonempty(item.mime_type) });
        }
      } catch {
        /* Ignore unusable media URLs. */
      }
    }
  }
  const messageBody = text.join('\n').trim();
  if (!messageBody && attachments.length === 0) return null;
  return { fromPhone, chatId, messageId, service, messageBody, attachments };
}
