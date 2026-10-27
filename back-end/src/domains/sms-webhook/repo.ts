/**
 * SMS Webhook Domain Repository
 *
 * All Prisma calls for SMS webhook processing: user lookup, session management,
 * attention request updates, and agent lifecycle.
 */

import { prisma } from '../../providers/database';
import { OLDEST_ACCOUNT_FIRST, phoneOwnerWhere } from '../../providers/phoneAccountLookup';

/** Look up a user by phone number */
export async function findUserByPhone(phone: string) {
  return prisma.user.findFirst({
    where: phoneOwnerWhere(phone),
    orderBy: OLDEST_ACCOUNT_FIRST,
  });
}

/**
 * Find-or-create the User for an inbound number: the message proves possession
 * of the number, so a first-time texter is provisioned immediately (no OTP, no
 * signup wall). Concurrent first messages resolve to one account.
 */
export { provisionUserByPhone } from '../../providers/phoneAccountProvisioning';

/** Update an attention request with the user's response */
export async function updateAttentionRequest(id: string, userResponse: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { userResponse },
  });
}

/**
 * Upsert SMS session to clear message history. Advancing `lastInboundSeq`
 * supersedes every supervisor run in flight on ANY instance: their commit gate
 * (inboundSeqStillCurrent) refuses to write or reply once the seq has moved.
 */
export async function clearSmsSession(userId: string) {
  return prisma.smsSession.upsert({
    where: { userId },
    update: { messages: JSON.stringify([]), lastInboundSeq: { increment: 1 } },
    create: { userId, messages: JSON.stringify([]) },
  });
}

/** Find active SMS-source root agents for a user */
export async function findActiveSmsAgents(userId: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      source: 'SMS',
      deletedAt: null,
      parentAgentId: null, // Only root agents (children get cleaned up recursively)
    },
    select: { id: true, temporalWorkflowId: true },
  });
}

/** Read the current inbound seq for a user (returns null if no session). */
export async function getInboundSeq(userId: string): Promise<number | null> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { lastInboundSeq: true },
  });
  return session?.lastInboundSeq ?? null;
}
