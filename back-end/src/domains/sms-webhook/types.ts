/**
 * SMS Webhook Domain Types
 *
 * Surge webhook payload types and parsed message shapes.
 */

/** Parsed inbound SMS from Surge webhook payload */
export interface ParsedSurgeMessage {
  fromPhone: string;
  messageBody: string;
}
