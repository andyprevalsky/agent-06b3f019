import { broadcastAgentUpdate } from '../../providers/chat';
import { classifyAgentFailureForSurface } from '../../providers/credentialPropagation';
import { createLogger } from '../../providers/logger';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { finalizeAgent } from '../../providers/traceArchiveLifecycle';
import { maybeRecordStructuredGmv } from '../purchases/structuredGmv';
import type { Prisma, UpdateStatusBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED']);
const IRREVERSIBLE_STATUSES = new Set(['COMPLETED', 'FAILED']);
const NON_TERMINAL_STATUSES = new Set(['STARTING_UP', 'ACTIVE', 'PAUSED']);

interface UpdateAgentStatusDependencies {
  cleanupPurchaseCards?: (agentId: string) => Promise<void>;
}

async function runTerminalAgentCleanup(
  agentId: string,
  status: string,
  dependencies: UpdateAgentStatusDependencies
): Promise<void> {
  try {
    await (dependencies.cleanupPurchaseCards ?? cleanupAgentPurchaseCards)(agentId);
  } catch (error) {
    log.warn('Terminal purchase-card cleanup unavailable; cron will retry', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await finalizeAgent({ rootAgentId: agentId });
  } catch (error) {
    log.warn('Trace archive finalization unavailable', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function statusUpdate(body: UpdateStatusBody): Prisma.AgentUpdateManyMutationInput {
  return {
    status: body.status,
    statusMessage: body.statusMessage,
    progress: body.progress,
    tokenCount: body.tokenCount,
    tokensIn: body.tokensIn,
    tokensOut: body.tokensOut,
    contextSize: body.contextSize,
    messageCount: body.messageCount,
    ...(body.iterationOffset !== undefined && {
      workflowIterationOffset: body.iterationOffset,
    }),
    ...(body.structuredResponse !== undefined && {
      structuredResponse: body.structuredResponse as Prisma.InputJsonValue,
    }),
    updatedAt: new Date(),
  };
}

async function persistStatus(agentId: string, body: UpdateStatusBody, workflowGeneration?: string) {
  const update = statusUpdate(body);
  if (workflowGeneration === undefined) {
    return { accepted: true, agent: await repo.updateAgent(agentId, update) };
  }
  const accepted = await repo.updateAgentForWorkflow(agentId, workflowGeneration, update);
  return { accepted, agent: await repo.findAgentById(agentId) };
}

async function failureSurface(agentId: string, body: UpdateStatusBody) {
  if (!TERMINAL_STATUSES.has(body.status) || body.status === 'COMPLETED') return {};
  const fallback = { rawError: body.statusMessage ?? body.status, failureReason: null };
  try {
    const decision = await classifyAgentFailureForSurface(agentId);
    return {
      rawError: decision?.rawError ?? fallback.rawError,
      failureReason: decision?.failureReason ?? null,
    };
  } catch (error) {
    log.warn('Failure classification unavailable for terminal status broadcast', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

async function broadcastStatus(agentId: string, body: UpdateStatusBody): Promise<void> {
  await broadcastAgentUpdate(agentId, {
    progress: body.progress,
    status: body.status,
    statusMessage: body.statusMessage ?? undefined,
    tokenCount: body.tokenCount,
    tokensIn: body.tokensIn,
    tokensOut: body.tokensOut,
    contextSize: body.contextSize,
    messageCount: body.messageCount,
    ...(await failureSurface(agentId, body)),
  });
}

/** Persist worker status only if its producing workflow generation is still current. */
export async function updateAgentStatus(
  agentId: string,
  body: UpdateStatusBody,
  dependencies: UpdateAgentStatusDependencies = {},
  workflowGeneration?: string
) {
  const before = await repo.findAgentById(agentId);
  if (before === null) return null;
  if (
    workflowGeneration !== undefined &&
    before.temporalWorkflowId !== null &&
    before.temporalWorkflowId !== workflowGeneration
  ) {
    return before;
  }
  if (IRREVERSIBLE_STATUSES.has(before.status) && NON_TERMINAL_STATUSES.has(body.status)) {
    return before;
  }

  const result = await persistStatus(agentId, body, workflowGeneration);
  if (result.agent === null || !result.accepted) return result.agent;
  await broadcastStatus(agentId, body);
  // Platform GMV: any agent (root or child) that completes with a structured
  // output containing BOTH a USD amount and an order/confirmation id.
  if (body.status === 'COMPLETED' && body.structuredResponse !== undefined) {
    void maybeRecordStructuredGmv({
      userId: before.userId,
      agentId,
      structured: body.structuredResponse,
      source: 'agent.structuredResponse',
    });
  }
  const firstRootTerminal =
    TERMINAL_STATUSES.has(body.status) &&
    before.parentAgentId === null &&
    !TERMINAL_STATUSES.has(before.status);
  if (firstRootTerminal) await runTerminalAgentCleanup(agentId, body.status, dependencies);
  return result.agent;
}
