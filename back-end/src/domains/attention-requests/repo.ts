import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import type { CreateAttentionRequestInput } from './types';
import {
  broadcastAttentionUserMessages,
  persistAttentionUserMessages,
  attentionRequestWorkflowTargets,
} from '../../providers/attentionUserMessages';
import { assertAttentionWorkflowTargets } from '../../providers/attentionWorkflowTargets';

export async function validateCreateOwnership(data: CreateAttentionRequestInput): Promise<void> {
  await assertAttentionWorkflowTargets(prisma, data.userId, attentionRequestWorkflowTargets(data));
}

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
): Promise<{ pending: boolean; response: string | null; userMessage?: string }> {
  const result = await runTransactionWithRetry(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "AgentAttentionRequest" WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) return { pending: false, response: null };

    const row = await tx.agentAttentionRequest.findUnique({
      where: { id },
      select: { userId: true, userResponse: true, workflowId: true, agentId: true, metadata: true },
    });
    if (row === null) return { pending: false, response: null };
    await assertAttentionWorkflowTargets(tx, row.userId, [
      ...attentionRequestWorkflowTargets(row),
      { agentId, workflowId },
    ]);
    // A protocol-only resolution can precede its first authored reply. Keep
    // late waiters registered so that later input reaches the same fan-out.
    if (row.workflowId !== workflowId) {
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
    }
    if (row.userResponse !== null) {
      // Resolution may win after findPendingByGateKey but before this row lock.
      // Fan the same committed authored row into the late waiter's durable stream.
      const authored = await persistAttentionUserMessages(tx, {
        requestId: id,
        agentId: row.agentId,
        targetAgentIds: [agentId],
      });
      return { pending: false, response: row.userResponse, ...authored };
    }
    return { pending: true, response: null };
  });
  if ('userMessages' in result && result.userMessages !== undefined)
    broadcastAttentionUserMessages(result.userMessages);
  return {
    ...result,
    userMessage: 'userMessage' in result ? (result.userMessage ?? undefined) : undefined,
  };
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

/**
 * Agent-tools questions routed to a parent agent (display pinned from a nested
 * agent) are the parent's to answer, not the user's: keep them out of the
 * user's inbox and badge count. They stay answerable by id.
 */
function routedToParentAgent(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const agentTools = (metadata as { agentTools?: unknown }).agentTools;
  return (
    agentTools !== null &&
    typeof agentTools === 'object' &&
    (agentTools as { deliverTo?: unknown }).deliverTo === 'parent'
  );
}

/**
 * List attention requests for a user, excluding rows whose agent is archived.
 * `AgentAttentionRequest.agentId` is a plain string (no FK), so soft-delete
 * paths that forget to `deleteMany` would otherwise keep prompting forever.
 * Bound by this user's pending/answered request count — not by agent count.
 */
export async function findManyByUserId(userId: string) {
  const requests = await prisma.agentAttentionRequest.findMany({
    where: { userId },
    orderBy: { updatedAt: 'asc' },
  });
  if (requests.length === 0) return requests;

  const agentIds = [...new Set(requests.map((r) => r.agentId))];
  const liveAgents = await prisma.agent.findMany({
    where: { id: { in: agentIds }, deletedAt: null },
    select: { id: true },
  });
  const live = new Set(liveAgents.map((a) => a.id));
  return requests.filter((r) => live.has(r.agentId) && !routedToParentAgent(r.metadata));
}

export async function countUnanswered(userId: string) {
  const pending = await prisma.agentAttentionRequest.findMany({
    where: { userId, userResponse: null },
    select: { agentId: true, metadata: true },
  });
  if (pending.length === 0) return 0;

  const agentIds = [...new Set(pending.map((r) => r.agentId))];
  const liveAgents = await prisma.agent.findMany({
    where: { id: { in: agentIds }, deletedAt: null },
    select: { id: true },
  });
  const live = new Set(liveAgents.map((a) => a.id));
  return pending.filter((r) => live.has(r.agentId) && !routedToParentAgent(r.metadata)).length;
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
