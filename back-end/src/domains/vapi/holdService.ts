/**
 * wait_for_human: the backend owns the Twilio call and runs each Vapi
 * conversation as a bypass segment. Parking redirects the call to the hold
 * listener (no Vapi minutes); a live person re-enters a new segment.
 *
 *   Vapi segment ──wait_for_human──▶ hold stream ──LLM: live person──▶ Vapi segment
 *        ▲             (tool webhook)     (STT)                (bypass call + redirect)
 *        └─────────────────────────────── same Twilio call ───────────────────────┘
 */
import {
  HOLD_DETECTOR_CONTEXT_UTTERANCES,
  HOLD_STREAM_RECONNECT_LIMIT,
  HOLD_UTTERANCE_LIMIT,
  type HoldRuntimeConfig,
  type OutboundPhoneNumber,
} from './config';
import { detectLiveHuman, type HumanDetector } from './holdDetectorService';
import {
  fetchSegmentCalls,
  handleTwilioCallStatus,
  openHold,
  withFinalSegments,
} from './holdStatusService';
import {
  HANGUP_TWIML,
  buildHoldTwiml,
  createTwilioCall,
  hangUpTwilioCall,
  holdReconnectUrl,
  holdStatusCallbackUrl,
  holdToolUrl,
  redirectTwilioCall,
} from './holdTelephonyService';
import { asObject, buildResumedAssistant, renderPriorConversation } from './holdTranscriptService';
import * as repo from './repoHold';
import type { PhoneCallSessionRecord, PhoneHoldPeriod } from './types';
import { postVapiCall, VapiApiError } from './vapiClientService';
import { randomUUID } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHold');

type Json = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createBypassSegment(
  session: Pick<PhoneCallSessionRecord, 'phoneNumberId' | 'toNumber'>,
  assistant: Json
): Promise<{ id: string; twiml: string; response: Json; request: Json }> {
  const request = {
    phoneNumberId: session.phoneNumberId,
    customer: { number: session.toNumber },
    phoneCallProviderBypassEnabled: true,
    assistant,
  };
  const response = await postVapiCall(JSON.stringify(request));
  const text = await response.text();
  if (!response.ok) throw new VapiApiError(response.status, text);
  const result = JSON.parse(text) as Json;
  const twiml = asObject(result.phoneCallProviderDetails).twiml;
  if (typeof result.id !== 'string' || typeof twiml !== 'string' || twiml === '') {
    throw new VapiApiError(502, 'Vapi bypass call returned no id/twiml');
  }
  return { id: result.id, twiml, response: result, request };
}

export interface HoldCallPlacement {
  callId: string;
  status: string;
  request: Json;
  response: Json;
}

/** Places a hold-capable call: session row → Vapi bypass segment → Twilio call. */
export async function placeHoldCapableCall(input: {
  config: HoldRuntimeConfig;
  phone: OutboundPhoneNumber;
  to: string;
  operationKey?: string;
  agentId: string | null;
  userId?: string;
  buildAssistant: (waitForHumanToolUrl: string) => Json;
}): Promise<HoldCallPlacement> {
  const sessionId = randomUUID();
  const assistant = input.buildAssistant(holdToolUrl(input.config, sessionId));
  const session = await repo.createPhoneCallSession({
    id: sessionId,
    operationKey: input.operationKey,
    agentId: input.agentId,
    userId: input.userId ?? null,
    phoneNumberId: input.phone.id,
    fromNumber: input.phone.number,
    toNumber: input.to,
    assistantConfig: assistant,
  });
  try {
    const segment = await createBypassSegment(session, assistant);
    const twilioCallSid = await createTwilioCall(input.config, {
      to: input.to,
      from: input.phone.number,
      twiml: segment.twiml,
      statusCallback: holdStatusCallbackUrl(input.config, sessionId),
    });
    await repo.updatePhoneCallSession(sessionId, {
      rootVapiCallId: segment.id,
      activeVapiCallId: segment.id,
      twilioCallSid,
      state: 'connected',
      segments: [{ vapiCallId: segment.id, startedAt: new Date().toISOString() }],
    });
    log.info('Hold-capable call placed', { session_id: sessionId, vapi_call_id: segment.id });
    const status = typeof segment.response.status === 'string' ? segment.response.status : 'queued';
    return { callId: segment.id, status, request: segment.request, response: segment.response };
  } catch (error) {
    await repo.updatePhoneCallSession(sessionId, {
      state: 'ended',
      endedReason: 'call-create-failed',
      endedAt: new Date(),
    });
    throw error;
  }
}

/** wait_for_human tool call: park the Twilio call on the hold stream. */
export async function parkCallOnHold(
  config: HoldRuntimeConfig,
  sessionId: string,
  input: { vapiCallId?: string; heard?: string }
): Promise<string> {
  const session = await repo.findPhoneCallSession(sessionId);
  if (session === null || session.twilioCallSid === null) return 'This call cannot be put on hold.';
  if (session.state === 'on_hold') return 'You are on hold. Wait silently.';
  if (input.vapiCallId !== undefined && input.vapiCallId !== session.activeVapiCallId) {
    return 'This conversation segment is no longer active.';
  }
  const hold: PhoneHoldPeriod = {
    startedAt: new Date().toISOString(),
    heard: input.heard,
    streamConnects: 0,
    utterances: [],
  };
  const parked = await repo.transitionPhoneCallSession(sessionId, ['connected'], {
    state: 'on_hold',
    holds: [...session.holds, hold],
  });
  if (parked === null) return 'You are on hold. Wait silently.';
  try {
    await redirectTwilioCall(config, session.twilioCallSid, buildHoldTwiml(config, sessionId));
  } catch (error) {
    await repo.transitionPhoneCallSession(sessionId, ['on_hold'], {
      state: 'connected',
      holds: session.holds,
    });
    log.error('Failed to park call on hold', { session_id: sessionId, error: errorMessage(error) });
    return 'Could not put the call on hold. Keep listening on the line.';
  }
  log.info('Call parked on hold', { session_id: sessionId, agent_id: session.agentId });
  return 'You are on hold. You will be reconnected when a live person picks up.';
}

/** Session for an incoming hold stream, or null when it must be refused. */
export async function acceptHoldStream(sessionId: string): Promise<PhoneCallSessionRecord | null> {
  const session = await repo.findPhoneCallSession(sessionId);
  return session !== null && session.state === 'on_hold' ? session : null;
}

/** One committed hold-line utterance: classify it and re-enter on a live person. */
export async function handleHoldUtterance(
  config: HoldRuntimeConfig,
  sessionId: string,
  text: string,
  detector: HumanDetector = detectLiveHuman
): Promise<'hold' | 'resumed' | 'ignored'> {
  const session = await repo.findPhoneCallSession(sessionId);
  const hold = session === null ? undefined : openHold(session);
  if (session === null || session.state !== 'on_hold' || hold === undefined) return 'ignored';
  const detection = await detector({
    earlierUtterances: hold.utterances
      .slice(-HOLD_DETECTOR_CONTEXT_UTTERANCES)
      .map((utterance) => utterance.text),
    latestUtterance: text,
    agentId: session.agentId,
    userId: session.userId,
    sessionId,
  });
  const utterance = {
    at: new Date().toISOString(),
    text,
    liveHuman: detection.live_human,
    reason: detection.reason,
  };
  const updatedHold = {
    ...hold,
    utterances: [...hold.utterances, utterance].slice(-HOLD_UTTERANCE_LIMIT),
  };
  const recorded = await repo.transitionPhoneCallSession(sessionId, ['on_hold'], {
    holds: [...session.holds.slice(0, -1), updatedHold],
  });
  if (recorded === null) return 'ignored';
  if (!detection.live_human) return 'hold';
  return (await resumeFromHold(config, recorded, text)) ? 'resumed' : 'hold';
}

/** Re-enter the call with a new Vapi segment that answers the live person. */
export async function resumeFromHold(
  config: HoldRuntimeConfig,
  session: PhoneCallSessionRecord,
  humanUtterance: string
): Promise<boolean> {
  const hold = openHold(session);
  if (hold === undefined || session.twilioCallSid === null) return false;
  const closedHold = { ...hold, endedAt: new Date().toISOString(), humanUtterance };
  const holds = [...session.holds.slice(0, -1), closedHold];
  const reconnecting = await repo.transitionPhoneCallSession(session.id, ['on_hold'], {
    state: 'reconnecting',
    holds,
  });
  if (reconnecting === null) return false;
  try {
    const calls = await fetchSegmentCalls(reconnecting);
    const assistant = buildResumedAssistant(
      session.assistantConfig,
      renderPriorConversation(calls, holds),
      closedHold,
      humanUtterance
    );
    const segment = await createBypassSegment(session, assistant);
    await redirectTwilioCall(config, session.twilioCallSid, segment.twiml);
    await repo.transitionPhoneCallSession(session.id, ['reconnecting'], {
      state: 'connected',
      activeVapiCallId: segment.id,
      segments: [
        ...withFinalSegments(reconnecting, calls),
        { vapiCallId: segment.id, startedAt: new Date().toISOString() },
      ],
    });
    log.info('Call resumed from hold', { session_id: session.id, vapi_call_id: segment.id });
    return true;
  } catch (error) {
    log.error('Failed to resume call from hold; staying on hold', {
      session_id: session.id,
      error: errorMessage(error),
    });
    await repo.transitionPhoneCallSession(session.id, ['reconnecting'], {
      state: 'on_hold',
      holds: session.holds,
    });
    return false;
  }
}

/** TwiML for the hold stream's <Redirect>: reconnect the stream, or hang up. */
export async function holdReconnectTwiml(
  config: HoldRuntimeConfig,
  sessionId: string
): Promise<string> {
  const session = await repo.findPhoneCallSession(sessionId);
  if (session === null) return HANGUP_TWIML;
  if (session.state === 'reconnecting') {
    // A new segment's redirect is in flight; wait for it instead of hanging up.
    return `<Response><Pause length="1"/><Redirect method="POST">${holdReconnectUrl(config, sessionId).replace(/&/g, '&amp;')}</Redirect></Response>`;
  }
  const hold = openHold(session);
  if (session.state !== 'on_hold' || hold === undefined) return HANGUP_TWIML;
  const streamConnects = hold.streamConnects + 1;
  if (streamConnects > HOLD_STREAM_RECONNECT_LIMIT) {
    log.error('Hold stream kept dropping; hanging up', { session_id: sessionId });
    await repo.transitionPhoneCallSession(sessionId, ['on_hold'], {
      endedReason: 'hold-stream-failed',
    });
    if (session.twilioCallSid !== null) {
      await hangUpTwilioCall(config, session.twilioCallSid).catch((error: unknown) => {
        log.warn('Hang-up after hold stream failure failed', { error: errorMessage(error) });
      });
    }
    await handleTwilioCallStatus(sessionId, 'completed');
    return HANGUP_TWIML;
  }
  await repo.transitionPhoneCallSession(sessionId, ['on_hold'], {
    holds: [...session.holds.slice(0, -1), { ...hold, streamConnects }],
  });
  return buildHoldTwiml(config, sessionId);
}
