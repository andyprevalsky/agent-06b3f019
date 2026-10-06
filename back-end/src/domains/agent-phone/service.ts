import { createHash } from 'node:crypto';
import { listInboundMessagesForNumber, sendAgentPhoneMessage } from '../../providers/agentPhone';
import {
  buildMockAgentPhoneSendResult,
  shouldMockMessagingSend,
} from '../../providers/smsTransportMock';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  ToolSideEffectAlreadyStartedError,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import * as repo from './repo';
import type { AgentPhoneSmsMessage } from './types';

const OUTBOUND_OPERATION_TYPE = 'agentphone.message';

export class AgentPhoneMessageValidationError extends Error {}
export class AgentPhoneIdentityUnavailableError extends Error {}
export class AgentPhoneIdempotencyConflictError extends Error {}
export class AgentPhoneAgentUnauthorizedError extends Error {}

function outboundOperationKey(userId: string, agentId: string, idempotencyKey: string) {
  const digest = createHash('sha256')
    .update(`${userId}\0${agentId}\0${idempotencyKey}`)
    .digest('hex');
  return `${OUTBOUND_OPERATION_TYPE}:${digest}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameOutboundRequest(stored: unknown, expected: Record<string, string>) {
  const record = asRecord(stored);
  return record !== null && Object.entries(expected).every(([key, value]) => record[key] === value);
}

function validateOutboundRequest(params: {
  userId: unknown;
  agentId: unknown;
  idempotencyKey: unknown;
  phoneNumber: unknown;
  message: unknown;
}): Record<'user_id' | 'agent_id' | 'idempotency_key' | 'phone_number' | 'message', string> {
  const { userId, agentId, idempotencyKey, phoneNumber, message } = params;
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof agentId !== 'string' ||
    agentId === '' ||
    typeof idempotencyKey !== 'string' ||
    !idempotencyKey.match(/^[A-Za-z0-9_-]{1,200}$/) ||
    typeof phoneNumber !== 'string' ||
    !phoneNumber.match(/^\+[1-9]\d{1,14}$/) ||
    typeof message !== 'string' ||
    message.trim() === ''
  ) {
    throw new AgentPhoneMessageValidationError(
      'user_id, agent_id, idempotency_key, E.164 phone_number, and message are required'
    );
  }
  return {
    user_id: userId,
    agent_id: agentId,
    idempotency_key: idempotencyKey,
    phone_number: phoneNumber,
    message,
  };
}

function buildAgentPhoneOutboundResponse(receipt: {
  status: string;
  id: string;
  channel: string;
  fromNumber: string;
  toNumber: string;
  conversationId: string | null;
}) {
  return {
    success: true,
    status: receipt.status,
    message_id: receipt.id,
    provider: 'agentphone',
    provider_channel: receipt.channel,
    from_number: receipt.fromNumber,
    to_number: receipt.toNumber,
    conversation_id: receipt.conversationId,
  };
}

async function deliverAgentPhoneOutbound(params: {
  agentId: string;
  idempotencyKey: string;
  phoneNumber: string;
  message: string;
  identity: NonNullable<Awaited<ReturnType<typeof repo.findAgentIdentityForMessages>>>;
}) {
  const mockSeed = `${params.agentId}:${params.idempotencyKey}:${params.phoneNumber}:${params.message}`;
  const mockReason = await shouldMockMessagingSend('agentphone', params.agentId);
  return mockReason !== null
    ? buildMockAgentPhoneSendResult({
        fromNumber: params.identity.phone ?? '+10000000000',
        toNumber: params.phoneNumber,
        seed: mockSeed,
        reason: mockReason,
      })
    : sendAgentPhoneMessage({
        agentId: params.identity.phoneProviderAgentId,
        numberId: params.identity.phoneProviderNumberId,
        fromNumber: params.identity.phone,
        toNumber: params.phoneNumber,
        body: params.message,
      });
}

export async function sendOutboundAgentPhoneMessage(params: {
  userId: unknown;
  agentId: unknown;
  idempotencyKey: unknown;
  phoneNumber: unknown;
  message: unknown;
}) {
  const request = validateOutboundRequest(params);
  const {
    user_id: userId,
    agent_id: agentId,
    idempotency_key: idempotencyKey,
    phone_number: phoneNumber,
    message,
  } = request;

  const identity = await repo.findAgentIdentityForMessages(userId);
  const hasNumberId =
    typeof identity?.phoneProviderNumberId === 'string' && identity.phoneProviderNumberId !== '';
  const hasAgentId =
    typeof identity?.phoneProviderAgentId === 'string' && identity.phoneProviderAgentId !== '';
  const hasPhone = typeof identity?.phone === 'string' && /^\+[1-9]\d{1,14}$/.test(identity.phone);
  if (identity?.phoneProvider !== 'agentphone' || (!hasNumberId && !hasAgentId && !hasPhone)) {
    throw new AgentPhoneIdentityUnavailableError(
      'The user does not have an AgentPhone sender configured'
    );
  }

  // Bind mock selection to an agent the caller owns. Without this, a valid
  // sender userId plus an unrelated benchmark agentId would short-circuit to
  // synthetic success and skip AgentPhone (CodeRabbit finding).
  if (!(await repo.isAgentOwnedByUser(userId, agentId))) {
    throw new AgentPhoneAgentUnauthorizedError(
      'agent_id is not an agent owned by the authenticated user'
    );
  }

  const operationKey = outboundOperationKey(userId, agentId, idempotencyKey);
  const claim = await claimToolSideEffect({
    operationKey,
    operationType: OUTBOUND_OPERATION_TYPE,
    request: request as ToolSideEffectJson,
  });

  if (claim.status === 'existing') {
    if (!sameOutboundRequest(claim.record.request, request)) {
      throw new AgentPhoneIdempotencyConflictError(
        'idempotency_key was already used for a different AgentPhone message payload'
      );
    }
    if (claim.record.status === 'SUCCEEDED') {
      const response = asRecord(claim.record.response);
      if (response !== null) return response;
    }
    throw new ToolSideEffectAlreadyStartedError(claim.record);
  }

  try {
    const receipt = await deliverAgentPhoneOutbound({
      agentId,
      idempotencyKey,
      phoneNumber,
      message,
      identity,
    });
    const response = buildAgentPhoneOutboundResponse(receipt);
    await markToolSideEffectSucceeded({
      operationKey,
      externalId: receipt.id,
      response: response as ToolSideEffectJson,
    });
    return response;
  } catch (error) {
    await markToolSideEffectFailed({
      operationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function fetchAgentPhoneMessagesSince(
  userId: string,
  since: Date,
  limit: number
): Promise<AgentPhoneSmsMessage[]> {
  const identity = await repo.findAgentIdentityForMessages(userId);
  const numberId = identity?.phoneProviderNumberId?.trim() ?? '';
  const phoneNumber = identity?.phone?.trim() ?? '';
  if (identity?.phoneProvider !== 'agentphone' || (numberId === '' && phoneNumber === '')) {
    return [];
  }

  const messages = await listInboundMessagesForNumber(
    numberId !== ''
      ? { numberId, phoneNumber: phoneNumber || null, since, limit }
      : { phoneNumber, since, limit }
  );

  return messages.map((message) => ({
    ...message,
    credentialId: identity.phone ?? message.to,
    credentialPhone: identity.phone ?? message.to,
  }));
}
