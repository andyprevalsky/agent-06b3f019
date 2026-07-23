/**
 * Gate-resolution provider.
 *
 * Resolves gates riding on `AgentAttentionRequest.metadata` (marks the request
 * answered, then signals the primary workflow AND every deduped waiter so the
 * whole fanned-in set resumes). Lives in providers/ — not the attention-requests
 * domain — so the integrations OAuth callback and the Stripe webhook can resolve
 * gates without a cross-domain import (mirrors `authAssistanceCompletion`). Uses
 * Prisma + the Temporal client directly.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { findDeploymentFencedToolMessage, lockToolCallLifecycle } from './toolLifecycleMessages';
import { lockAgentWorkflowGeneration } from './workflowGeneration';

const log = createLogger('GateResolution');
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface GateWaiter {
  workflowId: string;
  agentId: string;
}

/** The minimal request shape the resolver reads (id + who to signal + waiters). */
export interface ResolvableGateRequest {
  id: string;
  workflowId: string;
  agentId: string;
  metadata: unknown;
}

function readWaiters(metadata: unknown): GateWaiter[] {
  if (metadata === null || typeof metadata !== 'object') return [];
  const raw = (metadata as { gateWaiters?: unknown }).gateWaiters;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is GateWaiter =>
      x !== null &&
      typeof x === 'object' &&
      typeof (x as GateWaiter).workflowId === 'string' &&
      typeof (x as GateWaiter).agentId === 'string'
  );
}

/** Signal a single workflow's `receive_user_response` inbox (best-effort). */
export async function signalWorkflow(
  workflowId: string,
  agentId: string,
  requestId: string,
  response: string
): Promise<void> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(
      'receive_user_response',
      JSON.stringify({ request_id: requestId, response })
    );
  } catch (error) {
    log.error('Failed to signal workflow', {
      workflow_id: workflowId,
      agent_id: agentId,
      error: errMsg(error),
    });
  }
}

/** Signal the primary workflow AND every deduped waiter that the gate resolved. */
async function signalAllWaiters(request: ResolvableGateRequest, response: string): Promise<void> {
  const targets = new Map<string, string>();
  targets.set(request.workflowId, request.agentId);
  for (const w of readWaiters(request.metadata)) {
    if (!targets.has(w.workflowId)) targets.set(w.workflowId, w.agentId);
  }
  for (const [workflowId, agentId] of targets) {
    await signalWorkflow(workflowId, agentId, request.id, response);
  }
}

export async function finishAttentionMessages(
  tx: Prisma.TransactionClient,
  request: ResolvableGateRequest
): Promise<number> {
  const pendingMessages = await tx.message.findMany({
    where: {
      agentId: request.agentId,
      role: 'TOOL',
      AND: [
        { metadata: { path: ['toolStatus'], equals: 'IN_PROGRESS' } },
        {
          OR: [
            {
              metadata: {
                path: ['requestUserApproval', 'attentionRequestId'],
                equals: request.id,
              },
            },
            { metadata: { path: ['attentionRequestId'], equals: request.id } },
          ],
        },
      ],
    },
    orderBy: { id: 'asc' },
    select: { id: true, metadata: true, workflowGeneration: true },
  });

  let finishedCount = 0;
  for (const message of pendingMessages) {
    if (message.metadata === null || Array.isArray(message.metadata)) continue;
    const metadata = message.metadata as Prisma.JsonObject;
    const toolCallId = metadata.toolCallId;
    if (typeof toolCallId === 'string' && toolCallId.length > 0) {
      const workflowGeneration = message.workflowGeneration ?? request.agentId;
      await lockAgentWorkflowGeneration(tx, request.agentId);
      await lockToolCallLifecycle(tx, request.agentId, workflowGeneration, toolCallId);
      const deploymentFence = await findDeploymentFencedToolMessage(
        tx,
        request.agentId,
        workflowGeneration,
        toolCallId
      );
      if (deploymentFence !== null) continue;
    }
    const current = await tx.message.findUnique({ where: { id: message.id } });
    if (current?.metadata === null || Array.isArray(current?.metadata)) continue;
    const currentMetadata = current?.metadata as Prisma.JsonObject | undefined;
    if (currentMetadata?.toolStatus !== 'IN_PROGRESS') continue;
    await tx.message.update({
      where: { id: message.id },
      data: {
        metadata: {
          ...currentMetadata,
          toolStatus: 'FINISHED',
        },
      },
    });
    finishedCount += 1;
  }

  return finishedCount;
}

/**
 * Resolve a gate: mark the response, then signal every waiter. The waiter list is
 * re-read AFTER the update (not from the pre-update snapshot) so a waiter that
 * joined during the resolve is included; once `userResponse` is set, the atomic
 * `appendGateWaiter` can no longer add new waiters (it returns the response and
 * the joiner is signaled directly), so this read captures the final set.
 */
export async function resolveAndSignal(
  request: ResolvableGateRequest,
  response: string
): Promise<{ resolved: boolean }> {
  const { fresh, finishedMessageCount, resolved } = await prisma.$transaction(async (tx) => {
    const updated = await tx.agentAttentionRequest.updateMany({
      where: { id: request.id, userResponse: null },
      data: { userResponse: response },
    });
    const current = await tx.agentAttentionRequest.findUnique({
      where: { id: request.id },
    });
    if (current === null) {
      throw new Error(`Attention request ${request.id} disappeared during resolution`);
    }
    if (updated.count === 0) {
      return { fresh: current, finishedMessageCount: 0, resolved: false };
    }
    const finishedCount = await finishAttentionMessages(tx, request);
    return { fresh: current, finishedMessageCount: finishedCount, resolved: true };
  });
  log.info('Resolved attention request read model', {
    request_id: request.id,
    agent_id: request.agentId,
    finished_message_count: finishedMessageCount,
    resolved,
  });
  if (!resolved) return { resolved: false };
  await signalAllWaiters(fresh, response);
  return { resolved: true };
}

/**
 * Resolver hook for external detections (Stripe webhook, OAuth callback, KYC
 * webhook). Finds the pending gate by dedup key, marks it answered, and signals
 * the primary workflow plus all deduped waiters.
 */
export async function resolvePendingGateByKey(
  userId: string,
  gateKey: string,
  response = 'RESOLVED'
): Promise<{ resolved: boolean; request_id?: string }> {
  const request = await prisma.agentAttentionRequest.findFirst({
    where: { userId, gateKey, userResponse: null },
    orderBy: { createdAt: 'asc' },
  });
  if (request === null) return { resolved: false };

  const result = await resolveAndSignal(request, response);
  return result.resolved
    ? { resolved: true, request_id: request.id }
    : { resolved: false };
}
