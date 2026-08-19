import type { Prisma } from '@prisma/client';
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
 * Gate requests (`gateKey` non-null) are deliberately excluded: they are a
 * cross-agent fan-in point. Several agents that hit the same gate collapse onto one
 * PENDING row and the extras live in `metadata.gateWaiters`
 * (`domains/attention-requests/service.ts` joinGateAsWaiter), so answering the row on
 * behalf of one fenced agent would strand every still-live waiter — `resolveAndSignal`
 * only signals waiters while `userResponse IS NULL`. Gates are owned by the gate
 * lifecycle and stay open for the user to resolve.
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
  const { count } = await client.agentAttentionRequest.updateMany({
    where: {
      agentId,
      ...(workflowGeneration === null ? {} : { workflowId: workflowGeneration }),
      gateKey: null,
      userResponse: null,
    },
    data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
  });
  return count;
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
