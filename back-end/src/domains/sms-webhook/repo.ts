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

/** Soft-delete an agent and all its children */
export async function softDeleteAgentAndChildren(agentId: string) {
  return prisma.agent.updateMany({
    where: {
      OR: [{ id: agentId }, { parentAgentId: agentId }],
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
}
