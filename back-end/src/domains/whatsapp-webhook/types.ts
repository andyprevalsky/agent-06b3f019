/**
 * WhatsApp Webhook Domain Types
 */

import type { WhatsAppMediaAttachment } from '../../providers/smsSupervisor/inboundMedia';

/** A parsed inbound WhatsApp text or media message. */
export interface ParsedWhatsAppMessage {
  /** Sender in E.164 with a leading '+', normalized from Meta's `wa_id`. */
  fromPhone: string;
  /** Message text. */
  messageBody: string;
  /** Meta message id (`wamid...`), for dedup/logging. */
  messageId: string;
  /** Native media references, resolved with Meta authentication by the media provider. */
  attachments?: WhatsAppMediaAttachment[];
}
