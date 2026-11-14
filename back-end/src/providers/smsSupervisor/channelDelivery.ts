/**
 * Supervisor channel delivery.
 *
 * The "SMS supervisor" is the conversational brain for texting Rose. It is
 * channel-agnostic: the same LLM loop, tool set, agent-spawning, and session
 * store serve both SMS (Surge) and WhatsApp (Meta Cloud API). Only the last
 * hop — the sender — differs. `sendOnChannel` picks it; everything upstream is
 * identical, which is why WhatsApp reuses the supervisor verbatim.
 *
 * Conversational replies go back on the single channel the user texted in on.
 * Proactive lifecycle/onboarding notifications are MIRRORED across every channel
 * the user is reachable on — see `notificationChannelsFor`.
 */

import { sendSms } from '../smsQueue';
import { isLinqEnabled, sendLinqMessage } from '../linq';
import { sendWhatsAppMessage, getWhatsAppConfig } from '../whatsappCloud';
import type { QuotedMessage } from './messageReply';
import { isEmojiOnlyMessage } from './emoji';

export type SupervisorChannel = 'SMS' | 'WHATSAPP';

type SendOptions = NonNullable<Parameters<typeof sendSms>[2]> & {
  replyToMessageId?: string;
  quotedMessage?: QuotedMessage;
};
// The WhatsApp result is a superset (adds `recipientUnreachable`), so it types
// both senders' returns.
type SendResult = Awaited<ReturnType<typeof sendWhatsAppMessage>> & { deliveredBody?: string };

/**
 * Deliver a message on one channel. Both senders return the identical
 * `{ success, messageSid?, error?, definitiveFailure? }` shape (WhatsApp adds an
 * optional `recipientUnreachable`), so callers never branch on channel.
 */
export async function sendOnChannel(
  channel: SupervisorChannel,
  phoneNumber: string,
  message: string,
  options?: SendOptions
): Promise<SendResult> {
  if (channel === 'WHATSAPP') {
    return sendWhatsAppMessage(phoneNumber, message, options);
  }
  const replyId = options?.replyToMessageId;
  // Old Surge/session IDs remain replyable as text after a number migration.
  if (
    isLinqEnabled(phoneNumber) &&
    (replyId === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replyId))
  ) {
    return sendLinqMessage(phoneNumber, message, options);
  }
  if (isEmojiOnlyMessage(message)) {
    return {
      success: false,
      error:
        'Native reactions are unavailable on SMS. Do not send a separate emoji acknowledgment; send a substantive reply instead.',
      definitiveFailure: true,
    };
  }
  if (options?.replyToMessageId !== undefined && options.quotedMessage === undefined) {
    return {
      success: false,
      error: 'SMS reply target content is missing',
      definitiveFailure: true,
    };
  }
  // SMS has no native reply attachment: the selected quote is delivered as text.
  const deliveredBody =
    options?.replyToMessageId === undefined || !options.quotedMessage
      ? message
      : `Replying to ${options.quotedMessage.role === 'user' ? 'your' : 'my'} message:\n“${options.quotedMessage.content}”\n\n${message}`;
  const deliveryOptions = { ...options };
  delete deliveryOptions.replyToMessageId;
  const delivery = await sendSms(phoneNumber, deliveredBody, deliveryOptions);
  return { ...delivery, ...(delivery.success ? { deliveredBody } : {}) };
}

/** True when the WhatsApp Cloud API transport is configured (creds present). */
export function isWhatsAppConfigured(): boolean {
  const { phoneNumberId, accessToken } = getWhatsAppConfig();
  return (
    phoneNumberId !== undefined &&
    phoneNumberId !== '' &&
    accessToken !== undefined &&
    accessToken !== ''
  );
}

/**
 * Channels a proactive lifecycle/onboarding notification should mirror to for a
 * user. SMS is always included (the historical default). WhatsApp is added only
 * when it is configured AND the number is KNOWN reachable (`true`) — i.e. the
 * user has texted our WhatsApp, which is also the only state in which Meta lets
 * us send a proactive (non-template) message. `null` (never texted us) and
 * `false` (undeliverable) both stay SMS-only, so we never hammer a number that
 * can't receive WhatsApp. An inbound WhatsApp message flips a user to `true`.
 */
export function notificationChannelsFor(whatsappReachable: boolean | null): SupervisorChannel[] {
  const channels: SupervisorChannel[] = ['SMS'];
  if (isWhatsAppConfigured() && whatsappReachable === true) {
    channels.push('WHATSAPP');
  }
  return channels;
}
