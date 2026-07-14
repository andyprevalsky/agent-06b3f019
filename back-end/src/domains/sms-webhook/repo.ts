/**
 * SMS Webhook Domain Repository
 *
 * All Prisma calls for SMS webhook processing: user lookup, session management,
 * attention request updates, and agent lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

/** Look up a user by phone number */
export async function findUserByPhone(phone: string) {
  return prisma.user.findFirst({
    where: { phone },
  });
}

/**
 * Find-or-create a User for an inbound phone number.
 *
 * An inbound SMS is itself proof of possession of the number (equivalent to an
 * OTP), so a first-time texter is provisioned immediately with a generated
 * `userId` — no OTP, no signup wall. Supabase auth-user creation is deferred
 * until a web gate needs a session (minted via a short-lived magic link). See
 * docs/plans/active/sms-onboarding-and-gates.md.
 *
 * Idempotent for the common single-inbound case: a concurrent double-send races
 * on the find, but that is rare and harmless (a follow-up should add a partial
 * unique index on phone to make it airtight).
 */
export async function provisionUserByPhone(phone: string) {
  const existing = await prisma.user.findFirst({ where: { phone } });
  if (existing) return { user: existing, created: false };
  const user = await prisma.user.create({
    data: { userId: randomUUID(), phone, isAnonymous: false },
  });
  return { user, created: true };
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

/** Read the current inbound seq for a user (returns null if no session). */
export async function getInboundSeq(userId: string): Promise<number | null> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { lastInboundSeq: true },
  });
  return session?.lastInboundSeq ?? null;
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
