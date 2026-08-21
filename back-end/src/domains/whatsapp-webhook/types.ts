/**
 * WhatsApp Webhook Domain Types
 */

/** A parsed inbound WhatsApp text message. */
export interface ParsedWhatsAppMessage {
  /** Sender in E.164 with a leading '+', normalized from Meta's `wa_id`. */
  fromPhone: string;
  /** Message text. */
  messageBody: string;
  /** Meta message id (`wamid...`), for dedup/logging. */
  messageId: string;
}
