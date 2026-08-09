/**
 * WhatsApp Webhook Validation & Parsing
 *
 * Pure functions for the Meta Cloud API webhook: subscription-verification
 * handshake and inbound-message parsing. No side effects, no state.
 *
 * Inbound payload shape (Meta):
 * {
 *   object: "whatsapp_business_account",
 *   entry: [{ id, changes: [{ field: "messages", value: {
 *     messaging_product: "whatsapp",
 *     metadata: { display_phone_number, phone_number_id },
 *     contacts: [{ wa_id, profile: { name } }],
 *     messages: [{ from, id, timestamp, type: "text", text: { body } }],
 *     statuses: [{ ... }]   // delivery receipts for OUTBOUND messages
 *   }}]}]
 * }
 */

import type { ParsedWhatsAppMessage } from './types';

export interface WebhookVerification {
  mode: string | undefined;
  token: string | undefined;
  challenge: string | undefined;
}

/**
 * Resolve Meta's GET subscription handshake. Returns the challenge string to
 * echo back when the mode is `subscribe` and the verify token matches, else
 * null (caller responds 403).
 */
export function resolveWebhookVerification(
  params: WebhookVerification,
  expectedToken: string | undefined
): string | null {
  if (expectedToken === undefined || expectedToken === '') return null;
  if (params.mode !== 'subscribe') return null;
  if (params.token !== expectedToken) return null;
  if (params.challenge === undefined) return null;
  return params.challenge;
}

/**
 * True when the payload carries only outbound delivery/read receipts
 * (`statuses`) and no inbound user `messages`. These must never be routed to
 * the supervisor as if the user texted.
 */
export function isStatusOnlyEvent(body: Record<string, unknown>): boolean {
  const changes = collectChanges(body);
  let sawStatuses = false;
  for (const value of changes) {
    if (Array.isArray(value.messages) && value.messages.length > 0) return false;
    if (Array.isArray(value.statuses) && value.statuses.length > 0) sawStatuses = true;
  }
  return sawStatuses;
}

function collectChanges(body: Record<string, unknown>): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (typeof change !== 'object' || change === null) continue;
      const value = (change as Record<string, unknown>).value;
      if (typeof value === 'object' && value !== null) {
        values.push(value as Record<string, unknown>);
      }
    }
  }
  return values;
}

/**
 * Extract the first inbound TEXT message from a Meta webhook payload. Returns
 * null when there is no inbound text (status-only receipts, non-text media, or
 * a malformed body). Non-text messages are intentionally not parsed in v1 —
 * they require the media-download API and are handled as a follow-up.
 */
export function parseWhatsAppInbound(body: Record<string, unknown>): ParsedWhatsAppMessage | null {
  for (const value of collectChanges(body)) {
    const messages = Array.isArray(value.messages) ? value.messages : [];
    for (const raw of messages) {
      if (typeof raw !== 'object' || raw === null) continue;
      const message = raw as Record<string, unknown>;
      if (message.type !== 'text') continue;
      const text = message.text as Record<string, unknown> | undefined;
      const textBody = typeof text?.body === 'string' ? text.body.trim() : '';
      const from = typeof message.from === 'string' ? message.from : '';
      const messageId = typeof message.id === 'string' ? message.id : '';
      if (textBody === '' || from === '') continue;
      return { fromPhone: normalizeWaId(from), messageBody: textBody, messageId };
    }
  }
  return null;
}

/**
 * Meta reports `from`/`wa_id` as digits in international format WITHOUT a
 * leading '+'. Our `User.phone` is stored E.164 with '+', so normalize to match
 * (the outbound sender strips it back off).
 */
export function normalizeWaId(waId: string): string {
  const digits = waId.replace(/[^\d]/g, '');
  return digits === '' ? waId : `+${digits}`;
}
