import {
  primitiveDomain,
  sendPrimitiveEmail,
  type PrimitiveAttachment,
} from '../../providers/primitive';
import { senderLocalPart, senderOverride } from './config';

/**
 * From address for application notifications.
 *
 * Resolved here rather than in config.ts because it depends on the Primitive
 * provider for the verified outbound domain, and config may not import
 * providers. Must sit on a Primitive-verified outbound domain or the relay
 * rejects the send.
 */
export function notificationSender(): string {
  return senderOverride() ?? `${senderLocalPart()}@${primitiveDomain()}`;
}

/** Shape of a single outbound notification. */
export interface NotificationMessage {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: PrimitiveAttachment[];
}

/**
 * Deliver one application notification through Primitive's outbound relay.
 * Resolves true when the relay accepted the message.
 */
export async function sendNotification(message: NotificationMessage): Promise<boolean> {
  return await sendPrimitiveEmail(message);
}
