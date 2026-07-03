/**
 * SMS Webhook Domain Types
 *
 * Surge webhook payload types and parsed message shapes.
 */

/** Media attachment on an inbound Surge message (MMS photo, voice note, etc.) */
export interface SurgeAttachment {
  url: string;
  /** Content-type hint from the webhook payload (e.g. "image/jpeg"), if present. */
  type: string | null;
}

/** Parsed inbound SMS from Surge webhook payload */
export interface ParsedSurgeMessage {
  fromPhone: string;
  messageBody: string;
  attachments: SurgeAttachment[];
}
