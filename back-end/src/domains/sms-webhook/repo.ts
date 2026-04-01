/**
 * SMS Webhook Domain Repository
 *
 * All Prisma calls for SMS webhook processing: user lookup, session management,
 * attention request updates, and agent lifecycle.
 */

import { prisma } from '../../providers/database';

/** Look up a user by phone number */
export async function findUserByPhone(phone: string) {
  return prisma.user.findFirst({
    where: { phone },
  });
}

/** Update an attention request with the user's response */
export async function updateAttentionRequest(id: string, userResponse: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { userResponse },
  });
}

/** Upsert SMS session to clear message history */
export async function clearSmsSession(userId: string) {
  return prisma.smsSession.upsert({
    where: { userId },
    update: { messages: JSON.stringify([]) },
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

/** Soft-delete an agent and all descendants (children, grandchildren, etc.) */
export async function softDeleteAgentAndChildren(agentId: string) {
  // Use recursive CTE to find all descendants, then soft-delete them all
  await prisma.$executeRaw`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Agent" WHERE id = ${agentId} AND "deletedAt" IS NULL
      UNION ALL
      SELECT a.id FROM "Agent" a
      JOIN descendants d ON a."parentAgentId" = d.id
      WHERE a."deletedAt" IS NULL
    )
    UPDATE "Agent" SET "deletedAt" = NOW()
    WHERE id IN (SELECT id FROM descendants)
  `;
}
