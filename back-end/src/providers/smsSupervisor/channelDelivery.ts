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
import { sendWhatsAppMessage, getWhatsAppConfig } from '../whatsappCloud';

export type SupervisorChannel = 'SMS' | 'WHATSAPP';

type SendOptions = Parameters<typeof sendSms>[2];
// The WhatsApp result is a superset (adds `recipientUnreachable`), so it types
// both senders' returns.
type SendResult = Awaited<ReturnType<typeof sendWhatsAppMessage>>;

/**
 * Deliver a message on one channel. Both senders return the identical
 * `{ success, messageSid?, error?, definitiveFailure? }` shape (WhatsApp adds an
 * optional `recipientUnreachable`), so callers never branch on channel.
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
