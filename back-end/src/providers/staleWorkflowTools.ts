import type { Prisma } from '@prisma/client';
import { prisma } from './database';
import { createMessage } from './messages';
import { isTerminalToolStatus } from './toolLifecycleMessages';
import { createLogger } from './logger';
import { DEPLOY_INTERRUPTED_TOOL_MESSAGE, messageWorkflowGeneration } from './workflowGeneration';

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

function attentionRequestId(metadata: Record<string, unknown>): string | null {
  const direct = metadataString(metadata, 'attentionRequestId');
  if (direct !== null) return direct;
  const approval = metadata.requestUserApproval;
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) return null;
  return metadataString(approval as Record<string, unknown>, 'attentionRequestId');
}

async function closeInterruptedAttentionRequest(
  agentId: string,
  workflowGeneration: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const requestId = attentionRequestId(metadata);
  if (requestId === null) return;
  await prisma.agentAttentionRequest.updateMany({
    where: {
      id: requestId,
      agentId,
      workflowId: workflowGeneration,
      userResponse: null,
    },
    data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
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
      await closeInterruptedAttentionRequest(agentId, workflowGeneration, terminalMetadata);
      interrupted += 1;
    }
  }

  log.info('Reconciled stale workflow tool calls', {
    agent_id: agentId,
    workflow_generation: workflowGeneration,
    candidate_count: candidates.size,
    interrupted_count: interrupted,
  });
  return { candidates: candidates.size, interrupted };
}
