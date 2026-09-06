/**
 * Idempotent Gmail send for Temporal retries (message_person email channel).
 *
 * Wraps sendEmail with ToolSideEffect claim/succeed/fail so a completed send is
 * never repeated when Temporal retries the activity after a lost completion RPC.
 */
import { createHash } from 'node:crypto';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  ToolSideEffectAlreadyStartedError,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';

const GMAIL_SEND_OPERATION_TYPE = 'gmail.message';

export class GmailSendIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailSendIdempotencyConflictError';
  }
}

function outboundOperationKey(userId: string, agentId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${agentId}\0${idempotencyKey}`)
    .digest('hex');
  return `${GMAIL_SEND_OPERATION_TYPE}:${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameOutboundRequest(stored: unknown, expected: Record<string, string>): boolean {
  const record = asRecord(stored);
  return record !== null && Object.entries(expected).every(([key, value]) => record[key] === value);
}

export async function sendEmailOnce(
  userId: string,
  params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    fromEmail: string;
    agentId: string;
    idempotencyKey: string;
  }
): Promise<{ id: string; threadId: string }> {
  const request: Record<string, string> = {
    user_id: userId,
    agent_id: params.agentId,
    idempotency_key: params.idempotencyKey,
    to: params.to,
    from_email: params.fromEmail,
    subject: params.subject,
    body: params.body,
  };
  if (params.cc !== undefined && params.cc !== '') {
    request.cc = params.cc;
  }

  const operationKey = outboundOperationKey(userId, params.agentId, params.idempotencyKey);
  const claim = await claimToolSideEffect({
    operationKey,
    operationType: GMAIL_SEND_OPERATION_TYPE,
    request: request as ToolSideEffectJson,
  });

  if (claim.status === 'existing') {
    if (!sameOutboundRequest(claim.record.request, request)) {
      throw new GmailSendIdempotencyConflictError(
        'idempotency_key was already used for a different Gmail send payload'
      );
    }
    if (claim.record.status === 'SUCCEEDED') {
      const response = asRecord(claim.record.response);
      const id = response?.id;
      const threadId = response?.threadId;
      if (typeof id === 'string' && id !== '' && typeof threadId === 'string') {
        return { id, threadId };
      }
    }
    throw new ToolSideEffectAlreadyStartedError(claim.record);
  }

  try {
    const { sendEmail } = await import('./service');
    const result = await sendEmail(userId, {
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      fromEmail: params.fromEmail,
      agentId: params.agentId,
    });
    await markToolSideEffectSucceeded({
      operationKey,
      externalId: result.id,
      response: result as ToolSideEffectJson,
    });
    return result;
  } catch (error) {
    await markToolSideEffectFailed({
      operationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
