/**
 * Agents domain repo mutations — create, update, delete operations.
 */

import type { Prisma, AgentSource, VerifierType } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';
import { assertCurrentParentWorkflowGenerations } from './repoParentWorkflowFence';

export {
  clearWorkflowForTerminalAgent,
  createAgentTools,
  createGithubRepoAccess,
  deleteAgentTools,
  deleteAttentionRequests,
  DERIVED_RUN_STATE_RESET,
  followUpRunStateUpdate,
  shouldSnapshotPreviousGoal,
  failAgentIfStillActive,
  findArchivedAgent,
  replaceAgentTools,
  restoreAgentAndDescendants,
  softDeleteAgent,
  updateAgent,
} from './repoAgentMutations';

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
  workflowStartPhase?: string;
  workflowTaskQueue?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  fastModeCacheEnabled?: boolean;
  memoryEnabled?: boolean;
  worldModelMode?: 'real' | 'simulate' | 'shadow';
  isBenchmark?: boolean;
  githubRepoUrl?: string;
  originDeviceId?: string;
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
    ...(params.workflowStartPhase !== undefined
      ? { workflowStartPhase: params.workflowStartPhase }
      : {}),
    ...(params.workflowTaskQueue !== undefined
      ? { workflowTaskQueue: params.workflowTaskQueue }
      : {}),
    ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
      ? { priceLimitCents: params.priceLimitCents }
      : {}),
    ...(params.writeLockEnabled !== undefined ? { writeLockEnabled: params.writeLockEnabled } : {}),
    ...(params.fastModeCacheEnabled !== undefined
      ? { fastModeCacheEnabled: params.fastModeCacheEnabled }
      : {}),
    ...(params.memoryEnabled !== undefined ? { memoryEnabled: params.memoryEnabled } : {}),
    ...(params.worldModelMode !== undefined ? { worldModelMode: params.worldModelMode } : {}),
    ...(params.isBenchmark === true ? { isBenchmark: true } : {}),
    ...(params.githubRepoUrl !== undefined ? { githubRepoUrl: params.githubRepoUrl } : {}),
    ...(params.originDeviceId !== undefined ? { originDeviceId: params.originDeviceId } : {}),
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

export interface CreateAgentParams {
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
  memoryEnabled?: boolean;
  worldModelMode?: 'real' | 'simulate' | 'shadow';
  verifierType: string;
  isBenchmark?: boolean;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId?: string | null;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
  workflowStartPhase?: string;
  workflowTaskQueue?: string;
  /** Repository code sessions in this tree clone (set before the workflow starts). */
  githubRepoUrl?: string;
  /** Rose Mac app device that started this root agent (C14 local code agents). */
  originDeviceId?: string;
}

/** Create an agent with verifier and goal message in a transaction. */
export async function createAgentTransaction(params: CreateAgentParams) {
  // runTransactionWithRetry (not raw prisma.$transaction): interactive
  // transactions bypass the client's per-query retry extension, so a momentary
  // pool-pressure "Unable to start a transaction" (P2028) would 500 the whole
  // POST /api/agents. Agent creation is a hot, concurrency-spiky path (fan-outs,
  // the chat-lifecycle ratchet) — retrying the side-effect-free start makes it
  // resilient to transient pool saturation.
  return runTransactionWithRetry(async (tx) => {
    await assertCurrentParentWorkflowGenerations(tx, [params]);
    const tracksDescendantStart =
      params.parentAgentId !== null &&
      params.parentWorkflowId !== null &&
      params.temporalWorkflowId !== undefined &&
      params.temporalWorkflowId !== null;
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
        temporalWorkflowStartPending: tracksDescendantStart,
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
  memoryEnabled?: boolean;
  worldModelMode?: 'real' | 'simulate' | 'shadow';
  verifierType: string;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId: string;
  workflowMaxIterations?: number;
  workflowContextGates?: Record<string, boolean>;
  workflowStartPhase?: string;
  workflowTaskQueue?: string;
}

/** Create N agents (each with verifier + goal message) in a single transaction.
 *  All-or-nothing: if any row fails to insert, the whole batch rolls back. */
export async function createAgentBatchTransaction(items: BatchCreateAgentParams[]) {
  if (items.length === 0) return [];

  // Same rationale as createAgentTransaction: a batch fan-out is exactly when
  // the pool is most contended, so guard the interactive-transaction start.
  return runTransactionWithRetry(async (tx) => {
    await assertCurrentParentWorkflowGenerations(tx, items);
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
        temporalWorkflowStartPending:
          params.parentAgentId !== null && params.parentWorkflowId !== null,
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
