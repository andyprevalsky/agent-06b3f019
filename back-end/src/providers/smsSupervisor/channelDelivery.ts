/**
 * Supervisor channel delivery.
 *
 * The "SMS supervisor" is the conversational brain for texting Rose. It is
 * channel-agnostic: the same LLM loop, tool set, agent-spawning, and session
 * store serve both SMS (Surge) and WhatsApp (Meta Cloud API). Only the last
 * hop — the sender — differs. `sendOnChannel` picks it; everything upstream is
 * identical, which is why WhatsApp reuses the supervisor verbatim.
 */

import { sendSms } from '../smsQueue';
import { sendWhatsAppMessage } from '../whatsappCloud';

export type SupervisorChannel = 'SMS' | 'WHATSAPP';

type SendOptions = Parameters<typeof sendSms>[2];
type SendResult = Awaited<ReturnType<typeof sendSms>>;

/**
 * Deliver a user-facing message on the supervisor's active channel. Both
 * senders return the identical `{ success, messageSid?, error?,
 * definitiveFailure? }` shape, so callers never branch on channel.
 */
export function sendOnChannel(
  channel: SupervisorChannel,
  phoneNumber: string,
  message: string,
  options?: SendOptions
): Promise<SendResult> {
  if (channel === 'WHATSAPP') {
    return sendWhatsAppMessage(phoneNumber, message, options);
  }
  return sendSms(phoneNumber, message, options);
}
