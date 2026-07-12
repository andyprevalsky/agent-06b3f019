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

import { prisma } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';

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
): Promise<void> {
  await prisma.agentAttentionRequest.update({
    where: { id: request.id },
    data: { userResponse: response },
  });
  const fresh = await prisma.agentAttentionRequest.findUnique({ where: { id: request.id } });
  await signalAllWaiters(fresh ?? request, response);
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

  await resolveAndSignal(request, response);
  return { resolved: true, request_id: request.id };
}
