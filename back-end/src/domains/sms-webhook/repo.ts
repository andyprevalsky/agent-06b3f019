/**
 * SMS Webhook Domain Repository
 *
 * All Prisma calls for SMS webhook processing: user lookup, session management,
 * attention request updates, and agent lifecycle.
 */

import { randomUUID } from 'node:crypto';
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
 * Clear SMS session history and advance `lastInboundSeq`, which supersedes
 * every supervisor run in flight on ANY instance: their commit gate
 * (inboundSeqStillCurrent) refuses to write or reply once the seq has moved.
 *
 * The update is a compare-and-set on the seq read first. The Prisma query
 * layer replays a statement whose commit ack was lost (P1001/P1017); a replay
 * then matches no row instead of clearing a message that arrived meanwhile and
 * advancing the seq a second time.
 */
export async function clearSmsSession(userId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "SmsSession" (id, "userId", messages, "lastInboundSeq", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, to_jsonb('[]'::text), 0, NOW(), NOW())
    ON CONFLICT ("userId") DO NOTHING
  `;
  const current = await prisma.smsSession.findUnique({
    where: { userId },
    select: { lastInboundSeq: true },
  });
  const seq = current?.lastInboundSeq ?? 0;
  await prisma.smsSession.updateMany({
    where: { userId, lastInboundSeq: seq },
    data: { messages: JSON.stringify([]), lastInboundSeq: seq + 1 },
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
