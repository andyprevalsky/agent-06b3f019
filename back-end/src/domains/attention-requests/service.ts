import * as repo from './repo';
import type { CreateAttentionRequestInput, RespondInput } from './types';
import { REJECTED_RESPONSE } from './config';
import { createMessage } from '../../providers/messages';
import { createLogger } from '../../providers/logger';
import { logJson } from '../../utils/log';

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

export async function create(data: CreateAttentionRequestInput) {
  log.info('Received attention request', {
    agent_id: data.agentId,
    body: logJson(data),
  });

  const request = await repo.create(data);

  log.info('Attention request created', {
    request_id: request.id,
    agent_id: data.agentId,
  });

  return {
    id: request.id,
    created_at: request.createdAt,
    metadata: request.metadata,
  };
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

  // Map rejection-like responses to the __REJECTED__ sentinel so the
  // workflow correctly detects denial regardless of which endpoint is used.
  const REJECTION_WORDS = ['denied', 'deny', 'reject', 'rejected', 'no'];
  const normalised = data.response.trim().toLowerCase();
  const resolvedResponse = REJECTION_WORDS.includes(normalised) ? REJECTED_RESPONSE : data.response;

  await repo.updateResponse(id, resolvedResponse);
  await signalWorkflow(request.workflowId, request.agentId, id, resolvedResponse);

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
  await signalWorkflow(request.workflowId, request.agentId, id, REJECTED_RESPONSE);

  return { success: true, request_id: id };
}
