import {
  VAPI_BASE_URL,
  OUTBOUND_PHONE_NUMBER_POOL,
  BASE_SYSTEM_PROMPT,
  buildCallAssistantConfig,
  isIvrNavigationPrompt,
  reservedCalleePhoneNumberIds,
  resolveHoldRuntimeConfig,
  type HoldRuntimeConfig,
  type OutboundPhoneNumber,
} from './config';
import type { CreateCallRequest, VapiCallResponse } from './types';
import { logJson, logTruncate } from '../../utils/log';
import { createLogger } from '../../providers/logger';
import {
  assertSideEffectCanResume,
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
  ToolSideEffectAlreadyStartedError,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import { lookupUserVoiceAndName, normalizeJsonSchema, normalizePhoneNumber } from './helpers';
import {
  agentIdForCallId,
  agentIdFromOperationKey,
  archiveVapiJson,
  archiveVapiPollResult,
  buildVapiPollExchange,
} from './archive';
import { placeHoldCapableCall, type HoldCallPlacement } from './holdService';
import { getHoldCallStatus } from './holdStatusService';
import { TwilioApiError } from './holdTelephonyService';
import { rewriteEndedCallRecordingUrl } from './recordings';
import {
  fetchVapi,
  getVapiPrivateKey,
  postVapiCall,
  VapiApiError,
  VapiNotConfiguredError,
} from './vapiClientService';

const log = createLogger('Vapi');
const VAPI_CALL_OPERATION_TYPE = 'vapi.outbound_call';

type Json = Record<string, unknown>;

type PreparedCall = {
  phone: OutboundPhoneNumber;
  fullSystemPrompt: string;
  /** Caller-provided brief only (no base prompt) — used for IVR detection. */
  userSystemPrompt: string;
  normalizedPhone: string;
  normalizedSchema: Record<string, unknown>;
  operationKey?: string;
  userId?: string;
  voiceId?: string;
};

function getIdempotencyOperationKey(idempotencyKey: string): string {
  return `${VAPI_CALL_OPERATION_TYPE}:${idempotencyKey}`;
}

function getStoredCallStatus(response: unknown): string {
  if (typeof response !== 'object' || response === null) return 'queued';
  const status = (response as Record<string, unknown>).status;
  return typeof status === 'string' && status !== '' ? status : 'queued';
}

/**
 * Random caller ID from the pool, excluding numbers reserved for inbound
 * benchmark callees and the destination itself (a call must never dial itself).
 */
function selectOutboundPhoneNumber(to: string): OutboundPhoneNumber {
  if (OUTBOUND_PHONE_NUMBER_POOL.length === 0) throw new VapiNotConfiguredError();
  const reserved = reservedCalleePhoneNumberIds();
  const eligible = OUTBOUND_PHONE_NUMBER_POOL.filter(
    (phone) => !reserved.has(phone.id) && phone.number !== to
  );
  if (eligible.length === 0) {
    throw new VapiApiError(
      409,
      `No outbound caller number other than the destination ${to.substring(0, 4)}**** is available; refusing to place a call to itself.`
    );
  }
  return eligible[Math.floor(Math.random() * eligible.length)];
}

async function prepareCall(body: CreateCallRequest): Promise<PreparedCall> {
  const { to, system_prompt, output_schema, idempotency_key, user_id } = body;
  const operationKey =
    typeof idempotency_key === 'string' && idempotency_key !== ''
      ? getIdempotencyOperationKey(idempotency_key)
      : undefined;

  const { systemName, voiceId } = await lookupUserVoiceAndName(user_id);
  const identityPrefix = `You are ${systemName}.\n\n`;
  getVapiPrivateKey();
  const normalizedPhone = normalizePhoneNumber(to);

  return {
    phone: selectOutboundPhoneNumber(normalizedPhone),
    fullSystemPrompt: identityPrefix + BASE_SYSTEM_PROMPT + system_prompt,
    userSystemPrompt: system_prompt,
    normalizedPhone,
    normalizedSchema: normalizeJsonSchema(output_schema),
    operationKey,
    userId: typeof user_id === 'string' && user_id !== '' ? user_id : undefined,
    voiceId,
  };
}

async function getExistingIdempotentCall(
  call: PreparedCall
): Promise<{ success: true; call_id: string; status: string } | undefined> {
  if (call.operationKey === undefined) {
    return undefined;
  }

  let claim = await claimToolSideEffect({
    operationKey: call.operationKey,
    operationType: VAPI_CALL_OPERATION_TYPE,
    request: {
      to: call.normalizedPhone,
      output_schema: call.normalizedSchema,
    } as ToolSideEffectJson,
  });
  if (claim.status === 'existing' && claim.record.status === 'FAILED') {
    // A 400/wallet rejection records FAILED with no call_id. Reclaim so a
    // later funded retry can place the same idempotent outbound call.
    claim = await reclaimFailedToolSideEffect(call.operationKey);
  }
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

function buildAssistant(call: PreparedCall, waitForHumanToolUrl?: string): Json {
  return buildCallAssistantConfig(call.fullSystemPrompt, call.normalizedSchema, call.voiceId, {
    calleeSpeaksFirst: isIvrNavigationPrompt(call.userSystemPrompt),
    waitForHumanToolUrl,
  });
}

/** Vapi dials the callee itself; no hold parking. */
async function placeDirectCall(call: PreparedCall): Promise<HoldCallPlacement> {
  const request = {
    phoneNumberId: call.phone.id,
    customer: { number: call.normalizedPhone },
    assistant: buildAssistant(call),
  };
  const response = await postVapiCall(JSON.stringify(request));
  if (!response.ok) {
    const errorText = await response.text();
    log.error('Vapi API error', { status: response.status, details: logTruncate(errorText) });
    throw new VapiApiError(response.status, errorText);
  }
  const result = (await response.json()) as VapiCallResponse;
  if (typeof result.id !== 'string' || result.id === '') {
    throw new VapiApiError(502, 'Vapi response did not include a call id');
  }
  return { callId: result.id, status: result.status, request, response: result as Json };
}

async function placeHoldCall(
  call: PreparedCall,
  config: HoldRuntimeConfig
): Promise<HoldCallPlacement> {
  try {
    return await placeHoldCapableCall({
      config,
      phone: call.phone,
      to: call.normalizedPhone,
      operationKey: call.operationKey,
      agentId: agentIdFromOperationKey(call.operationKey),
      userId: call.userId,
      buildAssistant: (toolUrl) => buildAssistant(call, toolUrl),
    });
  } catch (error) {
    if (error instanceof TwilioApiError) throw new VapiApiError(error.statusCode, error.details);
    throw error;
  }
}

/**
 * Only an outright 4xx refusal from Vapi or Twilio proves nobody was dialed.
 * A timeout, a 5xx, or a failure after Twilio accepted the call may leave a
 * call ringing, so the side effect stays STARTED and a retry is refused.
 */
function isDefinitiveRejection(error: unknown): error is VapiApiError {
  return (
    error instanceof VapiApiError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408
  );
}

async function placeCall(call: PreparedCall): Promise<HoldCallPlacement> {
  const holdConfig = resolveHoldRuntimeConfig();
  try {
    return holdConfig === null
      ? await placeDirectCall(call)
      : await placeHoldCall(call, holdConfig);
  } catch (error) {
    if (call.operationKey !== undefined) {
      if (isDefinitiveRejection(error)) {
        await markToolSideEffectFailed({ operationKey: call.operationKey, error: error.details });
      } else {
        log.warn('Call placement outcome unknown; retries with this key will be refused', {
          operationKey: call.operationKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw error;
  }
}

/**
 * Initiate an outbound phone call via Vapi. When hold parking is configured the
 * backend owns the Twilio call and the assistant gets the wait_for_human tool.
 */
export async function initiateCall(
  body: CreateCallRequest
): Promise<{ success: true; call_id: string; status: string }> {
  const call = await prepareCall(body);
  const existingCall = await getExistingIdempotentCall(call);
  if (existingCall !== undefined) return existingCall;

  const placed = await placeCall(call);
  if (call.operationKey !== undefined) {
    await markToolSideEffectSucceeded({
      operationKey: call.operationKey,
      externalId: placed.callId,
      response: placed.response as ToolSideEffectJson,
    });
  }

  await archiveVapiJson(
    agentIdFromOperationKey(call.operationKey),
    `${placed.callId}.create.json.gz.enc`,
    { request: placed.request, response: placed.response, operationKey: call.operationKey }
  );

  log.info('Vapi call initiated', {
    callId: placed.callId,
    to: body.to.substring(0, 4) + '****',
    status: placed.status,
  });
  return { success: true, call_id: placed.callId, status: placed.status };
}

/** Poll call status from Vapi (merged across hold segments for hold-capable calls). */
export async function getCallStatus(callId: string): Promise<Record<string, unknown>> {
  const vapiPrivateKey = getVapiPrivateKey();
  const holdStatus = await getHoldCallStatus(resolveHoldRuntimeConfig(), callId);
  if (holdStatus !== null) {
    await archiveVapiPollResult(callId, holdStatus);
    log.info('Vapi hold-capable call poll', {
      callId,
      status: String(holdStatus.status),
      hold_state: String((holdStatus.phoneHold as Json | undefined)?.state),
    });
    return rewriteEndedCallRecordingUrl(holdStatus, callId, await agentIdForCallId(callId));
  }
  const requestUrl = `${VAPI_BASE_URL}/call/${callId}`;
  const startedAt = new Date();
  const response = await fetchVapi(
    requestUrl,
    { method: 'GET', headers: { Authorization: `Bearer ${vapiPrivateKey}` } },
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
  const rewritten = rewriteEndedCallRecordingUrl(result, callId, await agentIdForCallId(callId));
  log.info('Vapi call poll response', {
    callId,
    status: String(rewritten.status),
    duration: String(rewritten.duration),
    endedReason: String(rewritten.endedReason),
    fullResponse: logJson(rewritten),
  });
  return rewritten;
}
