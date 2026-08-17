/**
 * WhatsApp Webhook Domain Repository
 *
 * Prisma calls for inbound WhatsApp processing. Mirrors the SMS webhook's
 * user-provisioning + inbound-seq helpers; kept in-domain (rather than imported
 * from sms-webhook) to honor cross-domain isolation. The conversational session
 * itself is shared per-user via the smsSupervisor session store.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

/**
 * Find-or-create a User for an inbound WhatsApp number.
 *
 * An inbound WhatsApp message is proof of possession of the number (Meta
 * verified the sender), so a first-time texter is provisioned immediately with
 * a generated `userId` — no OTP, no signup wall — exactly like the SMS path.
 */
export async function provisionUserByPhone(phone: string) {
  const existing = await prisma.user.findFirst({ where: { phone } });
  if (existing) return { user: existing, created: false };
  const user = await prisma.user.create({
    data: { userId: randomUUID(), phone, isAnonymous: false },
  });
  return { user, created: true };
}

/** Read the current inbound seq for a user (null if no session yet). */
export async function getInboundSeq(userId: string): Promise<number | null> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { lastInboundSeq: true },
  });
  return session?.lastInboundSeq ?? null;
}
