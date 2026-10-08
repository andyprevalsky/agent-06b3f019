import type { HoldRuntimeConfig } from './config';
import { fetchTwilioCallStatus, hangUpTwilioCall } from './holdTelephonyService';
import { buildCompositeCall, segmentAnalysisReady } from './holdTranscriptService';
import * as repo from './repoHold';
import type { PhoneCallSessionRecord, PhoneCallSessionState, PhoneHoldPeriod } from './types';
import { getVapiCall } from './vapiClientService';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHold');

type Json = Record<string, unknown>;

const LIVE_STATES: PhoneCallSessionState[] = ['dialing', 'connected', 'on_hold', 'reconnecting'];
const TERMINAL_TWILIO_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

export function openHold(session: PhoneCallSessionRecord): PhoneHoldPeriod | undefined {
  const hold = session.holds[session.holds.length - 1];
  return hold !== undefined && hold.endedAt === undefined ? hold : undefined;
}

/** Each segment's Vapi call, from the cached terminal snapshot when available. */
export async function fetchSegmentCalls(session: PhoneCallSessionRecord): Promise<Json[]> {
  return Promise.all(
    session.segments.map(async (segment) => {
      if (segment.final !== undefined && segment.final !== null) return segment.final;
      try {
        return await getVapiCall(segment.vapiCallId);
      } catch (error) {
        log.warn('Failed to fetch Vapi segment', {
          vapi_call_id: segment.vapiCallId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { id: segment.vapiCallId, status: 'unknown' };
      }
    })
  );
}

export function withFinalSegments(
  session: PhoneCallSessionRecord,
  calls: Json[]
): PhoneCallSessionRecord['segments'] {
  return session.segments.map((segment, index) => {
    const call = calls[index] ?? {};
    const cached = segment.final !== undefined && segment.final !== null;
    return !cached && call.id === segment.vapiCallId && segmentAnalysisReady(call)
      ? { ...segment, final: call }
      : segment;
  });
}

function endedReasonForTwilioStatus(status: string, state: PhoneCallSessionState): string | null {
  if (status === 'busy') return 'customer-busy';
  if (status === 'no-answer') return 'customer-did-not-answer';
  if (status === 'failed') return 'twilio-failed-to-connect-call';
  if (status === 'canceled') return 'call-canceled';
  return state === 'on_hold' || state === 'reconnecting' ? 'customer-ended-call-during-hold' : null;
}

/** Twilio status callback (or a reconcile poll) reporting the call's terminal status. */
export async function handleTwilioCallStatus(sessionId: string, callStatus: string): Promise<void> {
  if (!TERMINAL_TWILIO_STATUSES.has(callStatus)) return;
  const now = new Date();
  const ended = await repo.mutatePhoneCallSession(sessionId, (session) => {
    if (!LIVE_STATES.includes(session.state)) return null;
    const hold = openHold(session);
    const reason = session.endedReason ?? endedReasonForTwilioStatus(callStatus, session.state);
    return {
      state: 'ended',
      endedAt: now,
      ...(reason !== null ? { endedReason: reason } : {}),
      ...(hold !== undefined
        ? { holds: [...session.holds.slice(0, -1), { ...hold, endedAt: now.toISOString() }] }
        : {}),
    };
  });
  if (ended === null) return;
  log.info('Hold-capable call ended', {
    session_id: sessionId,
    twilio_status: callStatus,
    reason: ended.endedReason,
  });
}

/** Hard ceiling on one hold: hang up instead of holding forever. */
export async function expireHold(config: HoldRuntimeConfig, sessionId: string): Promise<void> {
  const session = await repo.findPhoneCallSession(sessionId);
  if (session === null || session.state !== 'on_hold' || session.twilioCallSid === null) return;
  const marked = await repo.transitionPhoneCallSession(sessionId, ['on_hold'], {
    endedReason: 'hold-max-duration-exceeded',
  });
  if (marked === null) return;
  await hangUpTwilioCall(config, session.twilioCallSid);
  await handleTwilioCallStatus(sessionId, 'completed');
}

/** Merged status for a hold-capable call, or null for an ordinary Vapi call id. */
export async function getHoldCallStatus(
  config: HoldRuntimeConfig | null,
  rootVapiCallId: string
): Promise<Json | null> {
  let session = await repo.findPhoneCallSessionByRootVapiCallId(rootVapiCallId);
  if (session === null) return null;
  const calls = await fetchSegmentCalls(session);
  if (withFinalSegments(session, calls).some((segment, i) => segment !== session?.segments[i])) {
    // Re-derived from the latest row: a segment appended after `calls` was
    // fetched has no fetched call and is kept as is.
    const cached = await repo.mutatePhoneCallSession(session.id, (current) => {
      if (current.state === 'reconnecting') return null;
      const segments = withFinalSegments(current, calls);
      return segments.some((segment, i) => segment !== current.segments[i]) ? { segments } : null;
    });
    session = cached ?? session;
  }
  const last = calls[calls.length - 1] ?? {};
  if (
    config !== null &&
    session.state === 'connected' &&
    last.status === 'ended' &&
    session.twilioCallSid !== null
  ) {
    // The status callback can be lost; Twilio is the source of truth for the line.
    const twilioStatus = await fetchTwilioCallStatus(config, session.twilioCallSid);
    await handleTwilioCallStatus(session.id, twilioStatus);
    session = (await repo.findPhoneCallSession(session.id)) ?? session;
  }
  return buildCompositeCall(session, calls);
}
