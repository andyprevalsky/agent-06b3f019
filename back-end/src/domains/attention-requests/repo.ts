import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import type { CreateAttentionRequestInput } from './types';

export async function create(data: CreateAttentionRequestInput) {
  return prisma.agentAttentionRequest.create({
    data: {
      userId: data.userId,
      agentId: data.agentId,
      workflowId: data.workflowId,
      question: data.question,
      imageUrl: data.imageUrl,
      metadata: data.metadata,
      gateKey: data.gateKey,
    },
  });
}

/**
 * Find the single PENDING (unanswered) request for a (userId, gateKey) gate, if
 * any. Used to fan multiple agents in onto one gate instead of duplicating it.
 */
export async function findPendingByGateKey(userId: string, gateKey: string) {
  return prisma.agentAttentionRequest.findFirst({
    where: { userId, gateKey, userResponse: null },
    orderBy: { createdAt: 'asc' },
  });
}

/** Overwrite the metadata blob (used to append gate waiters on dedup). */
export async function updateMetadata(id: string, metadata: Prisma.InputJsonValue) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { metadata },
  });
}

/**
 * Atomically append a gate waiter under a row lock. Two agents deduping onto the
 * same gate concurrently would otherwise last-write-wins each other's waiter (a
 * lost waiter parks forever). The `FOR UPDATE` lock also serializes against the
 * resolver's `updateResponse`, so if the gate resolved during the join race we
 * return the stored response and skip the append — the caller signals the late
 * waiter directly instead of parking it on an already-resolved gate.
 */
export async function appendGateWaiter(
  id: string,
  workflowId: string,
  agentId: string
): Promise<{ pending: boolean; response: string | null }> {
  return runTransactionWithRetry(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "AgentAttentionRequest" WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) return { pending: false, response: null };

    const row = await tx.agentAttentionRequest.findUnique({
      where: { id },
      select: { userResponse: true, workflowId: true, metadata: true },
    });
    if (row === null) return { pending: false, response: null };
    if (row.userResponse !== null) return { pending: false, response: row.userResponse };
    if (row.workflowId === workflowId) return { pending: true, response: null };

    const base =
      row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? { ...(row.metadata as Record<string, unknown>) }
        : {};
    const waiters = Array.isArray(base.gateWaiters) ? [...(base.gateWaiters as unknown[])] : [];
    const already = waiters.some(
      (w) =>
        w !== null &&
        typeof w === 'object' &&
        (w as { workflowId?: unknown }).workflowId === workflowId
    );
    if (!already) {
      waiters.push({ workflowId, agentId });
      base.gateWaiters = waiters;
      await tx.agentAttentionRequest.update({
        where: { id },
        data: { metadata: base as Prisma.InputJsonValue },
      });
    }
    return { pending: true, response: null };
  });
}

/** Source of the agent that raised a request (SMS agents get a gate SMS). */
export async function findAgentSource(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { source: true },
  });
}

/** The user's phone number, if any (for dispatching a gate SMS). */
export async function findUserPhone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { phone: true },
  });
  return user?.phone ?? null;
}

export async function findById(id: string) {
  return prisma.agentAttentionRequest.findUnique({
    where: { id },
    include: {
      authAssistance: {
        select: { id: true },
      },
    },
  });
}

export async function findManyByUserId(userId: string) {
  return prisma.agentAttentionRequest.findMany({
    where: { userId },
    orderBy: { updatedAt: 'asc' },
  });
}

export async function countUnanswered(userId: string) {
  return prisma.agentAttentionRequest.count({
    where: { userId, userResponse: null },
  });
}

export async function updateResponse(id: string, userResponse: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { userResponse },
  });
}

export async function touchUpdatedAt(id: string) {
  return prisma.agentAttentionRequest.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
}
