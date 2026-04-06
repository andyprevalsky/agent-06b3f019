import {
  VAPI_BASE_URL,
  VAPI_PRIVATE_KEY,
  OUTBOUND_PHONE_NUMBER_POOL,
  BASE_SYSTEM_PROMPT,
} from './config';
import type { CreateCallRequest, VapiCallResponse } from './types';
import { logJson, logTruncate } from '../../utils/log';
import { createLogger } from '../../providers/logger';

const log = createLogger('Vapi');

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

/**
 * Initiate an outbound phone call via Vapi
 */
export async function initiateCall(
  body: CreateCallRequest
): Promise<{ success: true; call_id: string; status: string }> {
  const { to, system_prompt, output_schema } = body;

  const vapiPrivateKey = VAPI_PRIVATE_KEY;
  if (vapiPrivateKey === undefined || vapiPrivateKey === '') {
    log.error('VAPI_PRIVATE_KEY not configured');
    throw new VapiNotConfiguredError();
  }

  // Randomly select a phone number from the pool
  const phoneNumberId = getRandomPhoneNumberId();

  // Combine base prompt with LLM-defined system_prompt
  const fullSystemPrompt = BASE_SYSTEM_PROMPT + system_prompt;

  // Normalize phone number to E.164 format
  const normalizedPhone = normalizePhoneNumber(to);

  // Ensure output_schema is a valid JSON Schema with type field
  const normalizedSchema = normalizeJsonSchema(output_schema);

  // Create outbound call via Vapi API
  const response = await fetchVapi(
    `${VAPI_BASE_URL}/call`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vapiPrivateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: phoneNumberId,
        customer: {
          number: normalizedPhone,
        },
        assistant: {
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'system', content: fullSystemPrompt }],
          },
          voice: {
            provider: '11labs',
            voiceId: 'paula', // Default voice - can be made configurable later
          },
          firstMessage: 'Hello, how are you today?',
          analysisPlan: {
            structuredDataPlan: {
              enabled: true,
              schema: normalizedSchema,
            },
          },
        },
      }),
    },
    30_000
  );

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Vapi API error', { status: response.status, details: logTruncate(errorText) });
    throw new VapiApiError(response.status, errorText);
  }

  const result = (await response.json()) as VapiCallResponse;

  log.info('Vapi call initiated', {
    callId: result.id,
    to: to.substring(0, 4) + '****',
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
