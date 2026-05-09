import {
  VAPI_BASE_URL,
  VAPI_PRIVATE_KEY,
  OUTBOUND_PHONE_NUMBER_POOL,
  BASE_SYSTEM_PROMPT,
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

const log = createLogger('Vapi');
const VAPI_CALL_OPERATION_TYPE = 'vapi.outbound_call';

type PreparedCall = {
  vapiPrivateKey: string;
  phoneNumberId: string;
  fullSystemPrompt: string;
  normalizedPhone: string;
  normalizedSchema: Record<string, unknown>;
  operationKey?: string;
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

/**
 * Normalize JSON Schema to ensure it has a valid format for Vapi
 *
 * Handles malformed schemas like {"field_name": "description"} and converts them
 * to proper JSON Schema format.
 */
function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  if (typeof schema.type === 'string' && validTypes.includes(schema.type)) {
    return schema;
  }

  // If schema has properties but no type, it's meant to be an object
  if (schema.properties !== undefined && schema.type === undefined) {
    return { type: 'object', ...schema };
  }

  // Check if schema is malformed: {"field_name": "description", ...}
  const keys = Object.keys(schema);
  if (keys.length > 0 && keys.every((k) => typeof schema[k] === 'string')) {
    const properties: Record<string, unknown> = {};
    for (const key of keys) {
      properties[key] = {
        type: 'string',
        description: schema[key],
      };
    }
    return {
      type: 'object',
      properties,
    };
  }

  // Default to object type if no type specified
  return { type: 'object', ...schema };
}

/**
 * Normalize phone number to E.164 format (+1XXXXXXXXXX for US numbers)
 */
function normalizePhoneNumber(number: string): string {
  // Strip all non-digit characters
  const digits = number.replace(/\D/g, '');

  // Handle 11-digit US numbers (with leading 1)
  if (digits.length === 11 && digits.startsWith('1')) {
    return '+' + digits;
  }

  // Handle 10-digit US numbers (without country code)
  if (digits.length === 10) {
    return '+1' + digits;
  }

  // If already has + prefix, return as-is
  if (number.startsWith('+')) {
    return number;
  }

  // Otherwise prepend + and return
  return '+' + digits;
}

function prepareCall(body: CreateCallRequest): PreparedCall {
  const { to, system_prompt, output_schema, idempotency_key } = body;
  const operationKey =
    typeof idempotency_key === 'string' && idempotency_key !== ''
      ? getIdempotencyOperationKey(idempotency_key)
      : undefined;

  return {
    vapiPrivateKey: getVapiPrivateKey(),
    phoneNumberId: getRandomPhoneNumberId(),
    fullSystemPrompt: BASE_SYSTEM_PROMPT + system_prompt,
    normalizedPhone: normalizePhoneNumber(to),
    normalizedSchema: normalizeJsonSchema(output_schema),
    operationKey,
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
    assistant: {
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: call.fullSystemPrompt }],
      },
      voice: {
        provider: '11labs',
        voiceId: 'paula', // Default voice - can be made configurable later
      },
      firstMessage: 'Hello, how are you today?',
      analysisPlan: {
        structuredDataPlan: {
          enabled: true,
          schema: call.normalizedSchema,
        },
      },
    },
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
  const call = prepareCall(body);
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
  const response = await fetchVapi(
    `${VAPI_BASE_URL}/call/${callId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${vapiPrivateKey}`,
      },
    },
    15_000
  );

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Vapi API error', { status: response.status, details: logTruncate(errorText) });
    throw new VapiApiError(response.status, errorText);
  }

  const result = (await response.json()) as Record<string, unknown>;

  log.info('Vapi call poll response', {
    callId,
    status: String(result.status),
    duration: String(result.duration),
    endedReason: String(result.endedReason),
    fullResponse: logJson(result),
  });

  return result;
}
