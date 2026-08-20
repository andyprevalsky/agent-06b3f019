/**
 * Mirror the onboarding welcome to WhatsApp via an approved template.
 *
 * The SMS/iMessage welcome (`auth/service.ts:completeOnboarding`) is the primary
 * channel. This ALSO delivers the same welcome over WhatsApp for users who are
 * on WhatsApp — but a brand-new user has no open 24h session window, so it must
 * go through an approved TEMPLATE (`WHATSAPP_ONBOARDING_TEMPLATE`), not a
 * free-form send.
 *
 * Reachability discipline (mirrors the lifecycle-notification path so we never
 * hammer a non-WhatsApp number):
 *   - skip entirely if WhatsApp isn't configured, or the number is already known
 *     unreachable (`whatsappReachable === false`);
 *   - on a successful send, mark reachable (`true`);
 *   - on a Meta deliverability code (recipientUnreachable), mark unreachable
 *     (`false`) so future mirrors skip this number until they text us.
 */

import {
  sendWhatsAppTemplate,
  getWhatsAppConfig,
  WHATSAPP_ONBOARDING_TEMPLATE,
  type WhatsAppSendResult,
} from './whatsappCloud';
import {
  getWhatsAppReachable,
  markWhatsAppReachable,
  markWhatsAppUnreachable,
} from './whatsappReachability';
import { createLogger } from './logger';

const log = createLogger('WhatsApp Onboarding');

/**
 * Collaborators, injectable so the orchestration can be unit-tested without a
 * database or a live Meta call. Production uses the real implementations.
 */
export interface OnboardingMirrorDeps {
  getConfig: typeof getWhatsAppConfig;
  getReachable: typeof getWhatsAppReachable;
  sendTemplate: typeof sendWhatsAppTemplate;
  markReachable: typeof markWhatsAppReachable;
  markUnreachable: typeof markWhatsAppUnreachable;
}

const DEFAULT_DEPS: OnboardingMirrorDeps = {
  getConfig: getWhatsAppConfig,
  getReachable: getWhatsAppReachable,
  sendTemplate: sendWhatsAppTemplate,
  markReachable: markWhatsAppReachable,
  markUnreachable: markWhatsAppUnreachable,
};

export async function mirrorOnboardingWelcomeToWhatsApp(
  userId: string,
  phoneNumber: string,
  firstName: string,
  deps: OnboardingMirrorDeps = DEFAULT_DEPS
): Promise<void> {
  const { phoneNumberId, accessToken } = deps.getConfig();
  if (
    phoneNumberId === undefined ||
    phoneNumberId === '' ||
    accessToken === undefined ||
    accessToken === ''
  ) {
    return; // WhatsApp not configured — the SMS welcome already covers onboarding.
  }

  const reachable = await deps.getReachable(userId);
  if (reachable === false) {
    log.info('Skip WhatsApp onboarding welcome: number known-unreachable', { userId });
    return;
  }

  const result: WhatsAppSendResult = await deps.sendTemplate(
    phoneNumber,
    WHATSAPP_ONBOARDING_TEMPLATE.name,
    WHATSAPP_ONBOARDING_TEMPLATE.language,
    [firstName]
  );

  if (result.success) {
    await deps.markReachable(userId);
    log.info('Sent WhatsApp onboarding welcome template', { userId, messageId: result.messageSid });
    return;
  }
  if (result.recipientUnreachable === true) {
    await deps.markUnreachable(userId);
    return;
  }
  // Transient/other failure — do NOT flip reachability (it isn't a property of
  // the recipient number). The SMS welcome still landed.
  log.warn('WhatsApp onboarding welcome failed (transient/other)', {
    userId,
    error: result.error,
  });
}
