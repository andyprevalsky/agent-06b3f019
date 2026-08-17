/**
 * Per-number WhatsApp deliverability, used to mirror lifecycle/onboarding
 * notifications to WhatsApp without hammering numbers that cannot receive them.
 *
 * `User.whatsappReachable`:
 *   null  — unknown; a mirror may attempt WhatsApp ONCE, then learn from the result
 *   true  — reachable (received an inbound WhatsApp message, or a send succeeded)
 *   false — not reachable (send returned a Meta deliverability error); skip WhatsApp
 *
 * WhatsApp only allows proactive (non-template) messages inside the 24h window
 * after the user's last inbound. A user who has texted our WhatsApp number is in
 * that window; everyone else fails deliverability and is marked `false` so we
 * stop trying. An inbound WhatsApp message flips them back to `true`.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('WhatsAppReachability');

/** Record that a user can receive WhatsApp (inbound received or send succeeded). */
export async function markWhatsAppReachable(userId: string): Promise<void> {
  try {
    await prisma.user.update({ where: { userId }, data: { whatsappReachable: true } });
  } catch (error) {
    log.warn('Failed to mark WhatsApp reachable', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Record that a user cannot receive proactive WhatsApp messages, so lifecycle
 * mirroring stops targeting WhatsApp for them (until they text us again). A Meta
 * deliverability code is a definitive per-recipient signal, so this flips the
 * flag to false unconditionally — including from a previously-`true` state. A
 * rare race with a concurrent inbound (which sets `true`) is last-writer-wins
 * and self-heals: the next inbound WhatsApp message re-enables the user.
 */
export async function markWhatsAppUnreachable(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { userId },
      data: { whatsappReachable: false },
    });
    log.info('Marked WhatsApp unreachable; stop mirroring lifecycle to WhatsApp for this number', {
      userId,
    });
  } catch (error) {
    log.warn('Failed to mark WhatsApp unreachable', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Read a user's WhatsApp reachability (null = unknown). */
export async function getWhatsAppReachable(userId: string): Promise<boolean | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { whatsappReachable: true },
  });
  return user?.whatsappReachable ?? null;
}
