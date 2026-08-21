import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { createMessage } from './messages';
import { isTerminalToolStatus } from './toolLifecycleMessages';
import { createLogger } from './logger';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  lockAgentWorkflowGeneration,
  messageWorkflowGeneration,
} from './workflowGeneration';

const log = createLogger('StaleWorkflowTools');

export { DEPLOY_INTERRUPTED_TOOL_MESSAGE } from './workflowGeneration';

export interface ToolProgressCandidate {
  toolCallId: string;
  workflowGeneration: string;
  metadata: Record<string, unknown>;
}

export interface InterruptedWorkflowToolsResult {
  candidates: number;
  interrupted: number;
}

function metadataRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Close everything a sealed workflow generation was waiting on.
 *
 * The generation owns its attention requests through the durable
 * `AgentAttentionRequest(agentId, workflowId)` relation, so that relation — not the
 * shape of whatever tool chip happened to raise the request — is what decides which
 * rows to close. Correlating through chip metadata silently missed every request kind
 * the matcher did not enumerate: auth assistance stores its id under
 * `requestUserAuthentication.requestId`, so a deploy fenced the chip to
 * DEPLOY_INTERRUPTED and left the request pending forever (prod agents
 * 2dc4c954-0af7-4f50-8336-11f9925f3c05 and a87224a7-f9ac-4d09-b8c6-b758f37bac38).
 *
 * A gate row is the one case where `(agentId, workflowId)` is not sole ownership.
 * Several agents that hit the same gate collapse onto ONE pending row and the extras
 * live in `metadata.gateWaiters` (`domains/attention-requests/repo.ts`
 * appendGateWaiter). Answering such a row on behalf of one fenced agent would strand
 * every still-live waiter, because `gateResolution.resolveAndSignal` signals waiters
 * only while `userResponse IS NULL`. So a gate is closed only when this generation is
 * its sole occupant.
 *
 * It must still be closed in that sole-occupant case: the partial unique index
 * `(userId, gateKey) WHERE userResponse IS NULL` means a stale pending gate blocks the
 * replacement workflow from ever raising a fresh one
 * (`workflow-restart-tools.test.ts` "…so retry creates a fresh gate").
 *
 * `workflowGeneration` is null only for a pending descendant start that never
 * recorded a stale generation; there, every open request on the agent is owned by
 * the start being abandoned.
 */
export async function closeInterruptedAttentionRequests(
  client: Pick<Prisma.TransactionClient, 'agentAttentionRequest'>,
  agentId: string,
  workflowGeneration: string | null
): Promise<number> {
  const scope = {
    agentId,
    ...(workflowGeneration === null ? {} : { workflowId: workflowGeneration }),
    userResponse: null,
  };
  const open = await client.agentAttentionRequest.findMany({
    where: scope,
    select: { id: true, gateKey: true, metadata: true },
  });
  const closable = open.filter(
    (row) =>
      row.gateKey === null || !hasForeignGateWaiter(row.metadata, agentId, workflowGeneration)
  );
  if (closable.length === 0) return 0;

  let closed = 0;
  for (const row of closable) {
    // `appendGateWaiter` holds this row FOR UPDATE. Compare the metadata snapshot
    // as well as the pending predicate so either cleanup wins first and the joiner
    // observes the terminal response, or the joiner commits first and this CAS
    // refuses to erase its newly appended waiter.
    const { count } = await client.agentAttentionRequest.updateMany({
      where: {
        id: row.id,
        userResponse: null,
        metadata: { equals: row.metadata === null ? Prisma.DbNull : row.metadata },
      },
      data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
    });
    closed += count;
  }
  return closed;
}

/** True when a deduped gate is also holding a waiter outside the sealed generation. */
function hasForeignGateWaiter(
  metadata: Prisma.JsonValue | null,
  agentId: string,
  workflowGeneration: string | null
): boolean {
  const record = metadataRecord(metadata);
  const waiters = record?.gateWaiters;
  if (!Array.isArray(waiters)) return false;
  return waiters.some((waiter) => {
    const entry = metadataRecord(waiter as Prisma.JsonValue);
    if (entry === null) return false;
    const waiterAgentId = metadataString(entry, 'agentId');
    const waiterWorkflowId = metadataString(entry, 'workflowId');
    return (
      waiterAgentId !== null &&
      waiterWorkflowId !== null &&
      (waiterAgentId !== agentId ||
        workflowGeneration === null ||
        waiterWorkflowId !== workflowGeneration)
    );
  });
}

/** Read the latest lifecycle state for every call in one workflow generation. */
export async function captureInProgressWorkflowTools(
  agentId: string,
  workflowGeneration = agentId
): Promise<ToolProgressCandidate[]> {
  const lifecycleMessages = await prisma.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      OR: [
        { metadata: { path: ['toolStatus'], equals: 'IN_PROGRESS' } },
        { metadata: { path: ['toolStatus'], equals: 'in_progress' } },
        { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
        { metadata: { path: ['toolStatus'], equals: 'finished' } },
        { metadata: { path: ['toolStatus'], equals: 'ERROR' } },
        { metadata: { path: ['toolStatus'], equals: 'error' } },
        { metadata: { path: ['toolStatus'], equals: 'SUCCESS' } },
        { metadata: { path: ['toolStatus'], equals: 'success' } },
        { metadata: { path: ['toolStatus'], equals: 'FAILED' } },
        { metadata: { path: ['toolStatus'], equals: 'failed' } },
        { metadata: { path: ['toolStatus'], equals: 'COMPLETED' } },
        { metadata: { path: ['toolStatus'], equals: 'completed' } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const latestLifecycle = new Map<
    string,
    { candidate: ToolProgressCandidate; terminal: boolean }
  >();
  for (const message of lifecycleMessages) {
    if (messageWorkflowGeneration(message) !== workflowGeneration) continue;
    const metadata = metadataRecord(message.metadata);
    if (metadata === null) continue;
    const toolCallId = metadataString(metadata, 'toolCallId');
    const toolStatus = metadataString(metadata, 'toolStatus');
    if (toolCallId === null || toolStatus === null) continue;
    if (isTerminalToolStatus(toolStatus) || toolStatus.toUpperCase() === 'IN_PROGRESS') {
      latestLifecycle.set(toolCallId, {
        candidate: { toolCallId, workflowGeneration, metadata },
        terminal: isTerminalToolStatus(toolStatus),
      });
    }
  }

  return Array.from(latestLifecycle.values())
    .filter((lifecycle) => !lifecycle.terminal)
    .map((lifecycle) => lifecycle.candidate);
}

/**
 * Close unresolved calls left by a terminated workflow. The durable replacement
 * claim seals the old generation before this runs. Each append shares that claim's
 * advisory lock, so a success committed before the seal wins; any later old-run
 * write is itself converted to the same terminal deployment error.
 */
export async function finalizeInterruptedWorkflowTools(
  agentId: string,
  workflowGeneration: string,
  preTerminationSnapshot: ToolProgressCandidate[] = []
): Promise<InterruptedWorkflowToolsResult> {
  const postTerminationSnapshot = await captureInProgressWorkflowTools(agentId, workflowGeneration);
  const candidates = new Map<string, ToolProgressCandidate>();
  for (const candidate of preTerminationSnapshot) {
    candidates.set(candidate.toolCallId, candidate);
  }
  for (const candidate of postTerminationSnapshot) {
    candidates.set(candidate.toolCallId, candidate);
  }

  let interrupted = 0;
  for (const [toolCallId, candidate] of candidates) {
    const terminal = await createMessage({
      agentId,
      role: 'TOOL',
      text: DEPLOY_INTERRUPTED_TOOL_MESSAGE,
      metadata: {
        ...candidate.metadata,
        workflowGeneration,
        toolCallId,
        toolStatus: 'FINISHED',
        title: 'Tool interrupted by deployment',
        error: true,
        errorCode: 'DEPLOY_INTERRUPTED',
        deploymentFenced: true,
      },
      allowDeploymentFinalizer: true,
    });
    const terminalMetadata = metadataRecord(terminal.metadata);
    if (terminalMetadata?.errorCode === 'DEPLOY_INTERRUPTED') {
      interrupted += 1;
    }
  }

  // Take the generation lock before terminalizing attention rows, matching the
  // order `gateResolution.resolveAndSignal` documents and relies on, so a user
  // response can never hold the row while waiting for cleanup's lock.
  const closedAttentionRequests = await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    return closeInterruptedAttentionRequests(tx, agentId, workflowGeneration);
  });

  log.info('Reconciled stale workflow tool calls', {
    agent_id: agentId,
    workflow_generation: workflowGeneration,
    candidate_count: candidates.size,
    interrupted_count: interrupted,
    closed_attention_requests: closedAttentionRequests,
  });
  return { candidates: candidates.size, interrupted };
}
