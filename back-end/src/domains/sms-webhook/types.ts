/**
 * SMS Webhook Domain Types
 *
 * Surge webhook payload types, parsed message shapes, and shortcode result types.
 */

/** Parsed inbound SMS from Surge webhook payload */
export interface ParsedSurgeMessage {
  fromPhone: string;
  messageBody: string;
}

/** Result from looking up and consuming a shortcode */
export interface ShortcodeResult {
  attentionRequestId: string;
  agentId: string;
  workflowId: string;
}
