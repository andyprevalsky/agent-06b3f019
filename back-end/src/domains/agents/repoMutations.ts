/**
 * Agents domain repo mutations — create, update, delete operations.
 */

import type { Prisma, AgentSource, AgentStatus, VerifierType } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';

// ---------------------------------------------------------------------------
// Agent mutations
// ---------------------------------------------------------------------------

/**
 * Optional Agent columns that are only written when the caller supplied a value,
 * so DB-level defaults stand otherwise. Kept out of createAgentTransaction to keep
 * that function under the line budget.
 */
function optionalAgentCreateFields(params: {
  temporalWorkflowId?: string | null;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  fastModeCacheEnabled?: boolean;
  isBenchmark?: boolean;
}): Partial<Prisma.AgentUncheckedCreateInput> {
  return {
    ...(params.temporalWorkflowId !== undefined && params.temporalWorkflowId !== null
      ? { temporalWorkflowId: params.temporalWorkflowId }
      : {}),
    ...(params.workflowMaxIterations !== undefined
      ? { workflowMaxIterations: params.workflowMaxIterations }
      : {}),
    ...(params.workflowContextGates !== undefined
      ? { workflowContextGates: params.workflowContextGates }
      : {}),
    ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
      ? { priceLimitCents: params.priceLimitCents }
      : {}),
    ...(params.writeLockEnabled !== undefined ? { writeLockEnabled: params.writeLockEnabled } : {}),
    ...(params.fastModeCacheEnabled !== undefined
      ? { fastModeCacheEnabled: params.fastModeCacheEnabled }
      : {}),
    ...(params.isBenchmark === true ? { isBenchmark: true } : {}),
  };
}

async function createAttachmentMessages(
  tx: Prisma.TransactionClient,
  agentId: string,
  attachments: Array<Record<string, unknown>>
) {
  for (const attachment of attachments) {
    await tx.message.create({
      data: {
        agentId,
        text: '',
        role: 'USER',
        timestamp: new Date(),
        filePointer: attachment as Prisma.JsonObject,
      },
    });
  }
}

/** Create an agent with verifier and goal message in a transaction. */
export async function createAgentTransaction(params: {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  parentWorkflowId: string | null;
  depth: number;
  busId: string | null;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  source: string;
  tokenInPriceMicrodollars: number | null;
  tokenOutPriceMicrodollars: number | null;
  pauseState: boolean;
  responseSchema: unknown | undefined;
  proxyCountry: string;
  proxyState?: string;
  proxyCity?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  fastModeCacheEnabled?: boolean;
  verifierType: string;
  isBenchmark?: boolean;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId?: string | null;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
}) {
  // runTransactionWithRetry (not raw prisma.$transaction): interactive
  // transactions bypass the client's per-query retry extension, so a momentary
  // pool-pressure "Unable to start a transaction" (P2028) would 500 the whole
  // POST /api/agents. Agent creation is a hot, concurrency-spiky path (fan-outs,
  // the chat-lifecycle ratchet) — retrying the side-effect-free start makes it
  // resilient to transient pool saturation.
  return runTransactionWithRetry(async (tx) => {
    const newAgent = await tx.agent.create({
      data: {
        id: params.agentId,
        userId: params.userId,
        parentAgentId: params.parentAgentId,
        parentWorkflowId: params.parentWorkflowId,
        depth: params.depth,
        busId: params.busId,
        goal: params.goal,
        model: params.model,
        reasoningMaxTokens: params.reasoningMaxTokens,
        source: params.source as AgentSource,
        tokenInPriceMicrodollars: params.tokenInPriceMicrodollars,
        tokenOutPriceMicrodollars: params.tokenOutPriceMicrodollars,
        progress: 0.0,
        status: params.pauseState ? 'PAUSED' : 'STARTING_UP',
        responseSchema: params.responseSchema ?? undefined,
        proxyCountry: params.proxyCountry,
        proxyState: params.proxyState,
        proxyCity: params.proxyCity,
        ...optionalAgentCreateFields(params),
      },
    });

    await tx.verifier.create({
      data: {
        agentId: newAgent.id,
        type: params.verifierType as VerifierType,
      },
    });

    const goalMessage = await tx.message.create({
      data: {
        agentId: newAgent.id,
        text: params.goal,
        role: 'USER',
        timestamp: new Date(),
      },
    });

    if (params.attachments !== undefined && params.attachments.length > 0) {
      await createAttachmentMessages(tx, newAgent.id, params.attachments);
    }

    return { agent: newAgent, goalMessage };
  });
}

/** Update worker-owned fields only while the producing workflow is still current. */
export async function updateAgentForWorkflow(
  agentId: string,
  workflowGeneration: string,
  data: Prisma.AgentUpdateManyMutationInput
) {
  const workflowMatches: Prisma.AgentWhereInput[] = [{ temporalWorkflowId: workflowGeneration }];
  // A brand-new legacy workflow uses agentId as its Workflow ID and can report
  // STARTING_UP before the creator stores that ID. Replacement generations are
  // preclaimed, so they must never use this null compatibility path.
  if (workflowGeneration === agentId) workflowMatches.push({ temporalWorkflowId: null });
  const result = await prisma.agent.updateMany({
    where: {
      id: agentId,
      deletedAt: null,
      OR: workflowMatches,
    },
    data,
  });
  return result.count === 1;
}

export interface BatchCreateAgentParams {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  parentWorkflowId: string | null;
  depth: number;
  busId: string | null;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  source: string;
  tokenInPriceMicrodollars: number | null;
  tokenOutPriceMicrodollars: number | null;
  pauseState: boolean;
  responseSchema: unknown | undefined;
  proxyCountry: string;
  proxyState?: string;
  proxyCity?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  fastModeCacheEnabled?: boolean;
  verifierType: string;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId: string;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
}

/** Create N agents (each with verifier + goal message) in a single transaction.
 *  All-or-nothing: if any row fails to insert, the whole batch rolls back. */
export async function createAgentBatchTransaction(items: BatchCreateAgentParams[]) {
  if (items.length === 0) return [];

  // Same rationale as createAgentTransaction: a batch fan-out is exactly when
  // the pool is most contended, so guard the interactive-transaction start.
  return runTransactionWithRetry(async (tx) => {
    const goalMessageTimestamp = new Date();
    await tx.agent.createMany({
      data: items.map((params) => ({
        id: params.agentId,
        userId: params.userId,
        parentAgentId: params.parentAgentId,
        parentWorkflowId: params.parentWorkflowId,
        depth: params.depth,
        busId: params.busId,
        goal: params.goal,
        model: params.model,
        reasoningMaxTokens: params.reasoningMaxTokens,
        source: params.source as AgentSource,
        tokenInPriceMicrodollars: params.tokenInPriceMicrodollars,
        tokenOutPriceMicrodollars: params.tokenOutPriceMicrodollars,
        progress: 0.0,
        status: params.pauseState ? 'PAUSED' : 'STARTING_UP',
        responseSchema: params.responseSchema ?? undefined,
        proxyCountry: params.proxyCountry,
        proxyState: params.proxyState,
        proxyCity: params.proxyCity,
        ...optionalAgentCreateFields(params),
      })),
    });

    await tx.verifier.createMany({
      data: items.map((params) => ({
        agentId: params.agentId,
        type: params.verifierType as VerifierType,
      })),
    });

    await tx.message.createMany({
      data: items.map((params) => ({
        agentId: params.agentId,
        text: params.goal,
        role: 'USER',
        timestamp: goalMessageTimestamp,
      })),
    });

    const attachmentMessages = items.flatMap((params) =>
      (params.attachments ?? []).map((attachment) => ({
        agentId: params.agentId,
        text: '',
        role: 'USER' as const,
        timestamp: goalMessageTimestamp,
        filePointer: attachment as Prisma.JsonObject,
      }))
    );
    if (attachmentMessages.length > 0) {
      await tx.message.createMany({ data: attachmentMessages });
    }

    const createdAgents = await tx.agent.findMany({
      where: { id: { in: items.map((params) => params.agentId) } },
    });
    const createdById = new Map(createdAgents.map((agent) => [agent.id, agent]));
    return items.map((params) => ({ agent: createdById.get(params.agentId)! }));
  });
}

/** Update an agent's fields. */
export async function updateAgent(agentId: string, data: Record<string, unknown>) {
  return prisma.agent.update({
    where: { id: agentId },
    data,
  });
}

/** Mark an agent as FAILED only if it's still in a pre-terminal, non-paused state.
 *  Prevents background error handlers from overwriting user-initiated status changes. */
export async function failAgentIfStillActive(agentId: string, statusMessage: string) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: { in: ['STARTING_UP', 'ACTIVE'] },
    },
    data: { status: 'FAILED', statusMessage },
  });
}

/** Reactivate a terminal agent for chat by clearing its ended workflow — but ONLY
 *  if the row is still in the exact observed terminal status AND workflow id. If a
 *  concurrent reactivation already changed either, 0 rows update and the caller
 *  reloads instead of clobbering the newer workflow. Returns the update count. */
export async function clearWorkflowForTerminalAgent(
  agentId: string,
  observedStatus: AgentStatus,
  observedWorkflowId: string
) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: observedStatus,
      temporalWorkflowId: observedWorkflowId,
    },
    data: { temporalWorkflowId: null, status: 'ACTIVE' },
  });
}

/** Soft-delete an agent. */
export async function softDeleteAgent(agentId: string) {
  return prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });
}

/** Delete all attention requests for an agent. */
export async function deleteAttentionRequests(agentId: string) {
  return prisma.agentAttentionRequest.deleteMany({
    where: { agentId },
  });
}

/** Create a GitHub repo access record. */
export async function createGithubRepoAccess(userId: string, repoUrl: string) {
  return prisma.githubRepoAccess.create({
    data: { userId, repoUrl },
  });
}

/** Delete all tool assignments for an agent. */
export async function deleteAgentTools(agentId: string) {
  return prisma.agentTool.deleteMany({
    where: { agentId },
  });
}

/** Create tool assignments for an agent. */
export async function createAgentTools(agentId: string, toolIds: string[]) {
  return prisma.agentTool.createMany({
    data: toolIds.map((toolId) => ({
      agentId,
      toolId,
    })),
  });
}

/** Replace tool assignments atomically — delete old, create new in one transaction. */
export async function replaceAgentTools(agentId: string, toolIds: string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.agentTool.deleteMany({ where: { agentId } });
    await tx.agentTool.createMany({
      data: toolIds.map((toolId) => ({ agentId, toolId })),
    });
  });
}
