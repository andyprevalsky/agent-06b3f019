import {
  VAPI_BASE_URL,
  VAPI_PRIVATE_KEY,
  OUTBOUND_PHONE_NUMBER_POOL,
  BASE_SYSTEM_PROMPT,
  buildCallAssistantConfig,
} from './config';
import type { CreateCallRequest, VapiCallResponse } from './types';
import { logJson, logTruncate } from '../../utils/log';
import { createLogger } from '../../providers/logger';
import {
  assertSideEffectCanResume,
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  ToolSideEffectAlreadyStartedError,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import { lookupUserVoiceAndName, normalizeJsonSchema, normalizePhoneNumber } from './helpers';
import {
  agentIdFromOperationKey,
  archiveVapiJson,
  archiveVapiPollResult,
  type VapiPollExchange,
} from './archive';

const log = createLogger('Vapi');
const VAPI_CALL_OPERATION_TYPE = 'vapi.outbound_call';
const VAPI_POLL_DIAGNOSTIC_HEADERS = [
  'age',
  'cache-control',
  'cf-cache-status',
  'date',
  'etag',
  'last-modified',
  'server',
  'via',
  'x-cache',
] as const;

type PreparedCall = {
  vapiPrivateKey: string;
  phoneNumberId: string;
  fullSystemPrompt: string;
  normalizedPhone: string;
  normalizedSchema: Record<string, unknown>;
  operationKey?: string;
  voiceId?: string;
};

export class VapiNotConfiguredError extends Error {
  constructor() {
    super('Vapi not configured');
    this.name = 'VapiNotConfiguredError';
  }
}

export class VapiApiError extends Error {
  public statusCode: number;
  public details: string;

  constructor(statusCode: number, details: string) {
    super(`Vapi API error (${statusCode})`);
    this.name = 'VapiApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function getIdempotencyOperationKey(idempotencyKey: string): string {
  return `${VAPI_CALL_OPERATION_TYPE}:${idempotencyKey}`;
}

function getStoredCallStatus(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    return 'queued';
  }
  const status = (response as Record<string, unknown>).status;
  return typeof status === 'string' && status !== '' ? status : 'queued';
}

function getVapiPrivateKey(): string {
  const vapiPrivateKey = VAPI_PRIVATE_KEY;
  if (vapiPrivateKey === undefined || vapiPrivateKey === '') {
    log.error('VAPI_PRIVATE_KEY not configured');
    throw new VapiNotConfiguredError();
  }
  return vapiPrivateKey;
}

export function buildVapiPollExchange(
  requestUrl: string,
  startedAt: Date,
  receivedAt: Date,
  response: Response
): VapiPollExchange {
  const headers = Object.fromEntries(
    VAPI_POLL_DIAGNOSTIC_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
  return {
    request: {
      method: 'GET',
      url: requestUrl,
      startedAt: startedAt.toISOString(),
    },
    response: {
      status: response.status,
      headers,
      receivedAt: receivedAt.toISOString(),
      durationMs: Math.max(0, receivedAt.getTime() - startedAt.getTime()),
    },
  };
}

/** Fetch wrapper that converts AbortError (timeout) into VapiApiError. */
async function fetchVapi(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new VapiApiError(504, 'VAPI request timed out');
    }
    throw err;
  }
}

function getRandomPhoneNumberId(): string {
  if (OUTBOUND_PHONE_NUMBER_POOL.length === 0) {
    throw new VapiNotConfiguredError();
  }
  const index = Math.floor(Math.random() * OUTBOUND_PHONE_NUMBER_POOL.length);
  return OUTBOUND_PHONE_NUMBER_POOL[index];
}

async function prepareCall(body: CreateCallRequest): Promise<PreparedCall> {
  const { to, system_prompt, output_schema, idempotency_key, user_id } = body;
  const operationKey =
    typeof idempotency_key === 'string' && idempotency_key !== ''
      ? getIdempotencyOperationKey(idempotency_key)
      : undefined;

  const { systemName, voiceId } = await lookupUserVoiceAndName(user_id);
  const identityPrefix = `You are ${systemName}.\n\n`;

  return {
    vapiPrivateKey: getVapiPrivateKey(),
    phoneNumberId: getRandomPhoneNumberId(),
    fullSystemPrompt: identityPrefix + BASE_SYSTEM_PROMPT + system_prompt,
    normalizedPhone: normalizePhoneNumber(to),
    normalizedSchema: normalizeJsonSchema(output_schema),
    operationKey,
    voiceId,
  };
}

async function getExistingIdempotentCall(
  call: PreparedCall
): Promise<{ success: true; call_id: string; status: string } | undefined> {
  if (call.operationKey === undefined) {
    return undefined;
  }

  const claim = await claimToolSideEffect({
    operationKey: call.operationKey,
    operationType: VAPI_CALL_OPERATION_TYPE,
    request: {
      to: call.normalizedPhone,
      output_schema: call.normalizedSchema,
    } as ToolSideEffectJson,
  });
  if (claim.status !== 'existing') {
    return undefined;
  }

  try {
    const callId = assertSideEffectCanResume(claim.record);
    return {
      success: true,
      call_id: callId,
      status: getStoredCallStatus(claim.record.response),
    };
  } catch (error) {
    if (error instanceof ToolSideEffectAlreadyStartedError) {
      throw new VapiApiError(
        409,
        'A Vapi call was already attempted for this idempotency key, but no call_id was recorded. Refusing to place a duplicate call.'
      );
    }
    throw error;
  }
}

function buildCreateCallBody(call: PreparedCall): string {
  return JSON.stringify({
    phoneNumberId: call.phoneNumberId,
    customer: {
      number: call.normalizedPhone,
    },
    assistant: buildCallAssistantConfig(call.fullSystemPrompt, call.normalizedSchema, call.voiceId),
  });
}

async function createVapiCall(call: PreparedCall): Promise<Response> {
  try {
    return await fetchVapi(
      `${VAPI_BASE_URL}/call`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${call.vapiPrivateKey}`,
          'Content-Type': 'application/json',
        },
        body: buildCreateCallBody(call),
      },
      45_000
    );
  } catch (error) {
    if (call.operationKey !== undefined) {
      await markToolSideEffectFailed({
        operationKey: call.operationKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * Initiate an outbound phone call via Vapi
 */
export async function initiateCall(
  body: CreateCallRequest
): Promise<{ success: true; call_id: string; status: string }> {
  const call = await prepareCall(body);
  const existingCall = await getExistingIdempotentCall(call);
  if (existingCall !== undefined) {
    return existingCall;
  }

  // Create outbound call via Vapi API
  const response = await createVapiCall(call);

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Vapi API error', { status: response.status, details: logTruncate(errorText) });
    if (call.operationKey !== undefined) {
      await markToolSideEffectFailed({ operationKey: call.operationKey, error: errorText });
    }
    throw new VapiApiError(response.status, errorText);
  }

  const result = (await response.json()) as VapiCallResponse;
  if (typeof result.id !== 'string' || result.id === '') {
    const message = 'Vapi response did not include a call id';
    if (call.operationKey !== undefined) {
      await markToolSideEffectFailed({ operationKey: call.operationKey, error: message });
    }
    throw new VapiApiError(502, message);
  }

  if (call.operationKey !== undefined) {
    await markToolSideEffectSucceeded({
      operationKey: call.operationKey,
      externalId: result.id,
      response: result as ToolSideEffectJson,
    });
  }

  await archiveVapiJson(
    agentIdFromOperationKey(call.operationKey),
    `${result.id}.create.json.gz.enc`,
    {
      request: JSON.parse(buildCreateCallBody(call)) as unknown,
      response: result,
      operationKey: call.operationKey,
    }
  );

  log.info('Vapi call initiated', {
    callId: result.id,
    to: body.to.substring(0, 4) + '****',
    status: result.status,
  });

  return {
    success: true,
    call_id: result.id,
    status: result.status,
  };
}

/**
 * Poll call status from Vapi
 */
export async function getCallStatus(callId: string): Promise<Record<string, unknown>> {
  const vapiPrivateKey = VAPI_PRIVATE_KEY;
  if (vapiPrivateKey === undefined || vapiPrivateKey === '') {
    log.error('VAPI_PRIVATE_KEY not configured');
    throw new VapiNotConfiguredError();
  }

  // Get call status from Vapi API
  const requestUrl = `${VAPI_BASE_URL}/call/${callId}`;
  const startedAt = new Date();
  const response = await fetchVapi(
    requestUrl,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${vapiPrivateKey}`,
      },
    },
    15_000
  );
  const receivedAt = new Date();
  const exchange = buildVapiPollExchange(requestUrl, startedAt, receivedAt, response);

  if (!response.ok) {
    const errorText = await response.text();
    await archiveVapiPollResult(callId, { error: errorText }, exchange);
    log.error('Vapi API error', { status: response.status, details: logTruncate(errorText) });
    throw new VapiApiError(response.status, errorText);
  }

  const result = (await response.json()) as Record<string, unknown>;
  await archiveVapiPollResult(callId, result, exchange);

  log.info('Vapi call poll response', {
    callId,
    status: String(result.status),
    duration: String(result.duration),
    endedReason: String(result.endedReason),
    fullResponse: logJson(result),
  });

  return result;
}
