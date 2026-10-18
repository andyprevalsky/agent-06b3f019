import * as repo from './repo';
import { gateSchema, type CreateAttentionRequestInput, type RespondInput } from './types';
import { REJECTED_RESPONSE } from './config';
import { createLogger } from '../../providers/logger';
import {
  AUTH_ASSISTANCE_COMPLETED_RESPONSE,
  completeAuthAssistanceForUser,
} from '../../providers/authAssistanceCompletion';
import { isNativePhoneAttention } from '../../providers/nativePhoneAttention';
import { resumePausedAgentForUserMessage } from '../../providers/agentResume';
import { logJson } from '../../utils/log';
import { emitGateMessage, extractGate, maybeDispatchGateSms, toCreateResult } from './gateHelpers';
import {
  resolveAndSignal,
  signalWorkflow,
  type ResolvableGateRequest,
} from '../../providers/gateResolution';

const log = createLogger('Attention');
export {
  AttentionUserMessageConflictError,
  AttentionUserMessageForbiddenError,
} from '../../providers/attentionUserMessages';

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

/** Native attention accepts protocol answers; credential text stays in the phone broker. */
function assertNativePhoneResponse(metadata: unknown, response: string, userMessage?: string) {
  if (!isNativePhoneAttention(metadata)) return;
  if (
    (response.trim() !== AUTH_ASSISTANCE_COMPLETED_RESPONSE &&
      response.trim() !== REJECTED_RESPONSE) ||
    (userMessage !== undefined && userMessage.trim() !== '')
  )
    throw new ForbiddenError('Enter private information in the secure phone view.');
}

export async function validateCreateOwnership(
  data: CreateAttentionRequestInput,
  userId: string
): Promise<void> {
  if (data.userId !== userId) throw new ForbiddenError('Not authorized');
  await repo.validateCreateOwnership(data);
}

/**
 * Join an existing pending gate as a waiter. If the gate resolved during the
 * join race, signal this workflow directly so it isn't parked forever.
 */
async function joinGateAsWaiter(
  existingId: string,
  data: CreateAttentionRequestInput
): Promise<void> {
  const joined = await repo.appendGateWaiter(existingId, data.workflowId, data.agentId);
  if (!joined.pending && joined.response !== null) {
    await signalWorkflow(
      data.workflowId,
      data.agentId,
      existingId,
      joined.response,
      joined.userMessage ?? null
    );
  }
}

export async function create(data: CreateAttentionRequestInput) {
  await repo.validateCreateOwnership(data);
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
      await joinGateAsWaiter(existing.id, data);
      log.info('Gate deduped onto existing pending request', {
        request_id: existing.id,
        gate_key: data.gateKey,
        agent_id: data.agentId,
      });
      return toCreateResult(existing, true);
    }
    try {
      const created = await repo.create(data);
      if (gate !== undefined) {
        await emitGateMessage(data.agentId, data.workflowId, gate, created.id);
      }
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
          await joinGateAsWaiter(raced.id, data);
          return toCreateResult(raced, true);
        }
      }
      throw error;
    }
  }

  const request = await repo.create(data);
  if (gate !== undefined) {
    await emitGateMessage(data.agentId, data.workflowId, gate, request.id);
  }
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
  if (request.userId !== userId) {
    log.warn('Approval response refused for a different account', {
      request_id: id,
      agent_id: request.agentId,
      authenticated_user_id: userId,
      owner_user_id: request.userId,
    });
    throw new ForbiddenError(
      'Switch to the account that owns this approval request, then try again.'
    );
  }

  assertNativePhoneResponse(request.metadata, data.response, data.user_message);

  // A decline is an answer like any other gate's: it must reach the agent as a
  // decline, never be recorded as the user having signed in.
  if (request.authAssistance !== null && data.response.trim() !== REJECTED_RESPONSE) {
    const result = await completeAuthAssistanceForUser(
      id,
      userId,
      new Date(),
      {},
      data.user_message
    );
    if (result.status === 'not_found') throw new NotFoundError('Attention request not found');
    if (result.status === 'forbidden') throw new ForbiddenError('Not authorized');
    if (result.status === 'missing_steel_context') {
      throw new BadRequestError('Browser context is not available for this live_view request');
    }
    return { success: true, request_id: id };
  }

  await resolveAndSignalForUser(request, data.response, data.user_message);

  return { success: true, request_id: id };
}

/**
 * The user's answer is a send like any message, so it lifts a pause they set.
 * Gates resolved by webhooks (payments, OAuth) go through `resolveAndSignal`
 * alone and leave the pause to the user.
 */
async function resolveAndSignalForUser(
  request: ResolvableGateRequest,
  response: string,
  userMessage?: string
): Promise<void> {
  const { resolved } = await resolveAndSignal(request, response, userMessage);
  if (resolved) await resumePausedAgentForUserMessage(request.agentId);
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

  assertNativePhoneResponse(request.metadata, REJECTED_RESPONSE, message);

  await resolveAndSignalForUser(request, REJECTED_RESPONSE, message);

  return { success: true, request_id: id };
}
