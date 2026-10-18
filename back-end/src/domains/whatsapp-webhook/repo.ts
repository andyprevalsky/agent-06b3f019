/**
 * WhatsApp Webhook Domain Repository
 *
 * Prisma calls for inbound WhatsApp processing. Mirrors the SMS webhook's
 * user-provisioning + inbound-seq helpers; kept in-domain (rather than imported
 * from sms-webhook) to honor cross-domain isolation. The conversational session
 * itself is shared per-user via the smsSupervisor session store.
 */

import { prisma } from '../../providers/database';

/**
 * Find-or-create the User for an inbound number: the message proves possession
 * of the number, so a first-time texter is provisioned immediately (no OTP, no
 * signup wall). Concurrent first messages resolve to one account.
 */
export { provisionUserByPhone } from '../../providers/phoneAccountProvisioning';

/** Read the current inbound seq for a user (null if no session yet). */
export async function getInboundSeq(userId: string): Promise<number | null> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { lastInboundSeq: true },
  });
  return session?.lastInboundSeq ?? null;
}
