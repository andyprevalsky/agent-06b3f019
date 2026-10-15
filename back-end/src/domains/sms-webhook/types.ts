/**
 * SMS Webhook Domain Types
 *
 * Surge webhook payload types and parsed message shapes.
 */

import type { SurgeAttachment } from '../../providers/smsSupervisor/inboundMedia';

/** Canonical shape lives with the media processor in providers/smsSupervisor. */
export type { SurgeAttachment };

/** Parsed inbound SMS from Surge webhook payload */
export interface ParsedSurgeMessage {
  messageId?: string;
  fromPhone: string;
  messageBody: string;
  attachments: SurgeAttachment[];
}
