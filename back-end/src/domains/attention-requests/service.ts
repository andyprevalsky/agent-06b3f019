import * as repo from './repo';
import { gateSchema, type CreateAttentionRequestInput, type RespondInput } from './types';
import { REJECTED_RESPONSE } from './config';
import { createMessage } from '../../providers/messages';
import { createLogger } from '../../providers/logger';
import { completeAuthAssistanceForUser } from '../../providers/authAssistanceCompletion';
import { logJson } from '../../utils/log';
import {
  addWaiterIfNew,
  emitGateMessage,
  extractGate,
  maybeDispatchGateSms,
  readWaiters,
  toCreateResult,
} from './gateHelpers';

const log = createLogger('Attention');

export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}
export class ForbiddenError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}
export class BadRequestError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function signalWorkflow(
  workflowId: string,
  agentId: string,
  requestId: string,
  response: string
): Promise<void> {
  try {
    const { getTemporalClient } = await import('../../providers/temporal');
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
async function signalAllWaiters(
  request: { id: string; workflowId: string; agentId: string; metadata: unknown },
  response: string
): Promise<void> {
  const targets = new Map<string, string>();
  targets.set(request.workflowId, request.agentId);
  for (const w of readWaiters(request.metadata)) {
    if (!targets.has(w.workflowId)) targets.set(w.workflowId, w.agentId);
  }
  for (const [workflowId, agentId] of targets) {
    await signalWorkflow(workflowId, agentId, request.id, response);
  }
}

export async function create(data: CreateAttentionRequestInput) {
  log.info('Received attention request', {
    agent_id: data.agentId,
    body: logJson(data),
  });

  // Validate the Gate payload when one is attached (the standard object rides in
  // metadata.gate). An invalid gate throws ZodError → 400 via the route handler.
  const rawGate = extractGate(data.metadata);
  const gate = rawGate !== undefined ? gateSchema.parse(rawGate) : undefined;

  // Fan-in dedup: a PENDING gate with the same (userId, gateKey) is reused, so
  // multiple agents that hit the same gate collapse onto one request. Extra
  // agents become waiters so resolving the gate resumes all of them.
  if (data.gateKey !== undefined) {
    const existing = await repo.findPendingByGateKey(data.userId, data.gateKey);
    if (existing !== null) {
      await addWaiterIfNew(existing, data.workflowId, data.agentId);
      log.info('Gate deduped onto existing pending request', {
        request_id: existing.id,
        gate_key: data.gateKey,
        agent_id: data.agentId,
      });
      return toCreateResult(existing, true);
    }
    try {
      const created = await repo.create(data);
      if (gate !== undefined) await emitGateMessage(data.agentId, gate, created.id);
      const gateSms = gate !== undefined ? await maybeDispatchGateSms(data, gate) : undefined;
      log.info('Attention request created (gate)', {
        request_id: created.id,
        gate_key: data.gateKey,
        agent_id: data.agentId,
      });
      return toCreateResult(created, false, gateSms);
    } catch (error) {
      // Lost a race to a concurrent create for the same gate (partial unique
      // index) — join the winner as a waiter instead of erroring.
      if ((error as { code?: unknown }).code === 'P2002') {
        const raced = await repo.findPendingByGateKey(data.userId, data.gateKey);
        if (raced !== null) {
          await addWaiterIfNew(raced, data.workflowId, data.agentId);
          return toCreateResult(raced, true);
        }
      }
      throw error;
    }
  }

  const request = await repo.create(data);
  if (gate !== undefined) await emitGateMessage(data.agentId, gate, request.id);
  const gateSms = gate !== undefined ? await maybeDispatchGateSms(data, gate) : undefined;
  log.info('Attention request created', {
    request_id: request.id,
    agent_id: data.agentId,
  });
  return toCreateResult(request, false, gateSms);
}

export async function listForUser(userId: string) {
  const requests = await repo.findManyByUserId(userId);

  return {
    requests: requests.map((r) => ({
      id: r.id,
      agent_id: r.agentId,
      workflow_id: r.workflowId,
      question: r.question,
      image_url: r.imageUrl,
      metadata: r.metadata,
      user_response: r.userResponse,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      answered: r.userResponse !== null,
    })),
  };
}

export async function countForUser(userId: string) {
  const count = await repo.countUnanswered(userId);
  return { count };
}

export async function getById(id: string, userId: string | undefined, isInternal: boolean) {
  const request = await repo.findById(id);
  if (request === null) throw new NotFoundError('Attention request not found');

  if (!isInternal && request.userId !== userId) {
    throw new ForbiddenError('Not authorized');
  }

  return {
    id: request.id,
    agentId: request.agentId,
    workflowId: request.workflowId,
    question: request.question,
    imageUrl: request.imageUrl,
    metadata: request.metadata,
    userResponse: request.userResponse,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export async function respond(id: string, userId: string, data: RespondInput) {
  const request = await repo.findById(id);
  if (request === null) throw new NotFoundError('Attention request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not authorized');

  if (request.authAssistance !== null) {
    const result = await completeAuthAssistanceForUser(id, userId);
    if (result.status === 'not_found') throw new NotFoundError('Attention request not found');
    if (result.status === 'forbidden') throw new ForbiddenError('Not authorized');
    if (result.status === 'missing_steel_context') {
      throw new BadRequestError('Steel context is not available for this live_view request');
    }
    return { success: true, request_id: id };
  }

  await repo.updateResponse(id, data.response);
  await signalAllWaiters(request, data.response);

  return { success: true, request_id: id };
}

export async function skip(id: string, userId: string) {
  const request = await repo.findById(id);
  if (request === null) throw new NotFoundError('Attention request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not authorized');

  await repo.touchUpdatedAt(id);

  return { success: true, request_id: id };
}

export async function reject(id: string, userId: string, message: string | undefined) {
  const request = await repo.findById(id);
  if (request === null) throw new NotFoundError('Attention request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not authorized');

  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (trimmed.length > 0) {
    await createMessage({
      agentId: request.agentId,
      text: trimmed,
      role: 'USER',
    });
  }

  await repo.updateResponse(id, REJECTED_RESPONSE);
  await signalAllWaiters(request, REJECTED_RESPONSE);

  return { success: true, request_id: id };
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
  const request = await repo.findPendingByGateKey(userId, gateKey);
  if (request === null) return { resolved: false };

  await repo.updateResponse(request.id, response);
  await signalAllWaiters(request, response);
  return { resolved: true, request_id: request.id };
}
