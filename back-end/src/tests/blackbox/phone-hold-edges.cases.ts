/**
 * Edge cases for wait_for_human hold parking, run by phone-hold.blackbox.ts:
 * stream reconnect limit, hold ceiling, Twilio status mapping, lost callbacks,
 * failure handling, the kill switch, and the real human detector.
 */
import assert from 'node:assert/strict';
import { parseHoldTwiml, waitFor } from './phone-hold.fixtures';
import {
  AEROPLAN_AD,
  BRIEF,
  CALLEE,
  HANGUP,
  QUEUE_ANNOUNCEMENT,
  REP_GREETING,
  RUN_AGENT_ID,
  SCHEMA,
  asJson,
  endedVapiSegment,
  h,
  loadSession,
  openStream,
  park,
  placeCall,
  postForm,
  postTool,
  resolveConfig,
  type Json,
} from './phone-hold.support';

async function testRedirectReopensStreamUntilLimit(): Promise<void> {
  const placed = await placeCall();
  const { redirectUrl } = parseHoldTwiml(await park(placed));
  const sid = placed.session.twilioCallSid ?? '';

  const reopened = await (await postForm(redirectUrl, { CallSid: sid })).text();
  assert.match(reopened, /<Connect><Stream url="wss:\/\/hold\.example\.test/);
  let session = await loadSession(placed.session.id);
  assert.equal(session.holds[0].streamConnects, 1);

  await h.repo.transitionPhoneCallSession(session.id, ['on_hold'], { state: 'reconnecting' });
  const waiting = await (await postForm(redirectUrl, { CallSid: sid })).text();
  assert.match(waiting, /^<Response><Pause length="1"\/><Redirect method="POST">https:/);

  await h.repo.transitionPhoneCallSession(session.id, ['reconnecting'], {
    state: 'on_hold',
    holds: [{ ...session.holds[0], streamConnects: h.vapiConfig.HOLD_STREAM_RECONNECT_LIMIT }],
  });
  assert.equal(await (await postForm(redirectUrl, { CallSid: sid })).text(), HANGUP);
  assert.equal(h.upstream.twilioUpdates(sid).slice(-1)[0].get('Status'), 'completed');
  session = await loadSession(placed.session.id);
  assert.equal(session.state, 'ended');
  assert.equal(session.endedReason, 'hold-stream-failed');
  assert.ok(session.holds[0].endedAt);

  const forged = await postForm(redirectUrl.replace(/token=[^&]+/, 'token=forged'), {});
  assert.equal(forged.status, 403);
  assert.equal(await forged.text(), HANGUP);
}

async function testHoldEndsAtMaxDuration(): Promise<void> {
  const placed = await placeCall();
  const holdTwiml = await park(placed);
  const session = await loadSession(placed.session.id);
  const almostExpired = Date.now() - h.vapiConfig.HOLD_MAX_SECONDS * 1000 + 300;
  await h.repo.transitionPhoneCallSession(session.id, ['on_hold'], {
    holds: [{ ...session.holds[0], startedAt: new Date(almostExpired).toISOString() }],
  });
  const createdBefore = h.transcribers.created.length;
  const sid = placed.session.twilioCallSid ?? '';
  const client = await openStream(holdTwiml, sid);
  const transcriber = await waitFor(
    'hold transcriber',
    () => h.transcribers.created[createdBefore]
  );
  const ended = await waitFor('hold expiry', async () => {
    const latest = await loadSession(session.id);
    return latest.state === 'ended' ? latest : null;
  });
  assert.equal(ended.endedReason, 'hold-max-duration-exceeded');
  assert.equal(h.upstream.twilioUpdates(sid).slice(-1)[0].get('Status'), 'completed');
  assert.equal(transcriber.closed, true);
  client.close();
}

async function testTwilioStatusMapping(): Promise<void> {
  const parked = await placeCall();
  await park(parked);
  // The only Vapi segment ended (and was analysed) when the call was parked,
  // well before the hangup.
  h.upstream.vapiCalls.set(
    parked.callId,
    endedVapiSegment(parked.callId, {
      endedReason: 'assistant-forwarded-call',
      analysis: { summary: 'Reached the hold queue.' },
    })
  );
  await h.holdStatus.handleTwilioCallStatus(parked.session.id, 'completed');
  const hungUp = await loadSession(parked.session.id);
  assert.equal(hungUp.endedReason, 'customer-ended-call-during-hold');
  assert.ok(hungUp.holds[0].endedAt, 'hanging up closes the open hold');
  const composite = await h.service.getCallStatus(parked.callId);
  assert.equal(
    composite.endedAt,
    hungUp.endedAt?.toISOString(),
    'a call that ends on hold ends when the line hangs up, not when it was parked'
  );

  const busy = await placeCall();
  await h.holdStatus.handleTwilioCallStatus(busy.session.id, 'ringing');
  assert.equal((await loadSession(busy.session.id)).state, 'connected');
  await h.holdStatus.handleTwilioCallStatus(busy.session.id, 'busy');
  const ended = await loadSession(busy.session.id);
  assert.equal(ended.state, 'ended');
  assert.equal(ended.endedReason, 'customer-busy');
}

async function testLostStatusCallbackReconcilesFromTwilio(): Promise<void> {
  const placed = await placeCall();
  const segment = endedVapiSegment(placed.callId, {
    endedReason: 'assistant-ended-call',
    analysis: { summary: 'Done.' },
  });
  h.upstream.vapiCalls.set(placed.callId, segment);
  h.upstream.twilioStatuses.set(placed.session.twilioCallSid ?? '', 'completed');
  const status = await h.service.getCallStatus(placed.callId);
  assert.equal(status.status, 'ended');
  assert.equal((await loadSession(placed.session.id)).state, 'ended');
  assert.equal(
    status.endedAt,
    segment.endedAt,
    'a call that ends in a live segment ends with that segment, not when the poll noticed'
  );
}

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

async function testPlacementFailuresEndTheSession(): Promise<void> {
  const label = 'vapi-rejects';
  h.upstream.failNext('POST', /^\/call$/, 400, 'wallet balance too low');
  await assert.rejects(
    h.service.initiateCall({
      to: CALLEE,
      system_prompt: BRIEF,
      output_schema: SCHEMA,
      idempotency_key: `${RUN_AGENT_ID}:${label}`,
    }),
    (error: unknown) => statusCode(error) === 400
  );
  const retried = await placeCall(label);
  assert.equal(retried.session.state, 'connected', 'a failed placement can be retried');

  h.upstream.failNext('POST', /\/Calls\.json$/, 500, 'twilio down');
  await assert.rejects(placeCall('twilio-rejects'), (error: unknown) => statusCode(error) === 500);

  const failed = await h.prisma.phoneCallSession.findMany({
    where: {
      operationKey: {
        in: [
          `vapi.outbound_call:${RUN_AGENT_ID}:${label}`,
          `vapi.outbound_call:${RUN_AGENT_ID}:twilio-rejects`,
        ],
      },
      state: 'ended',
    },
  });
  assert.equal(failed.length, 2, 'each failed placement ended its session');
  for (const session of failed) {
    assert.equal(session.endedReason, 'call-create-failed');
    assert.equal(session.twilioCallSid, null);
  }
}

async function testParkFailureKeepsTheCallConnected(): Promise<void> {
  const placed = await placeCall();
  const sid = placed.session.twilioCallSid ?? '';
  h.upstream.failNext('POST', new RegExp(`/${sid}\\.json$`), 500);
  const response = await postTool(placed.toolUrl, placed.callId);
  assert.match(response.results[0]?.result ?? '', /Could not put the call on hold/);
  const session = await loadSession(placed.session.id);
  assert.equal(session.state, 'connected');
  assert.equal(session.holds.length, 0);
}

async function testResumeFailureStaysOnHold(): Promise<void> {
  const placed = await placeCall();
  await park(placed);
  h.upstream.vapiCalls.set(placed.callId, endedVapiSegment(placed.callId, { analysis: {} }));
  h.upstream.failNext('POST', /^\/call$/, 500);
  const outcome = await h.holdService.handleHoldUtterance(
    resolveConfig(),
    placed.session.id,
    REP_GREETING,
    async () => ({ live_human: true, reason: 'test' })
  );
  assert.equal(outcome, 'hold');
  const session = await loadSession(placed.session.id);
  assert.equal(session.state, 'on_hold');
  assert.equal(session.holds[0].endedAt, undefined, 'the hold stays open');
  assert.equal(session.holds[0].utterances.length, 1, 'the heard utterance is kept');
  assert.equal(session.segments.length, 1);
}

async function testKillSwitchPlacesDirectVapiCall(): Promise<void> {
  process.env.PHONE_HOLD_ENABLED = '0';
  try {
    const twilioCreates = h.upstream.twilioCreates().length;
    const result = await h.service.initiateCall({
      to: CALLEE,
      system_prompt: BRIEF,
      output_schema: SCHEMA,
      idempotency_key: `${RUN_AGENT_ID}:direct`,
    });
    const body = h.upstream.vapiCreates().slice(-1)[0];
    assert.equal(body.phoneCallProviderBypassEnabled, undefined);
    const tools = asJson(asJson(body.assistant).model).tools as Json[];
    assert.ok(tools.every((tool) => asJson(tool.function).name !== 'wait_for_human'));
    assert.equal(h.upstream.twilioCreates().length, twilioCreates, 'Vapi dials directly');
    h.upstream.vapiCalls.set(result.call_id, { id: result.call_id, status: 'ringing' });
    const status = await h.service.getCallStatus(result.call_id);
    assert.equal(status.status, 'ringing');
    assert.equal(status.phoneHold, undefined);
  } finally {
    delete process.env.PHONE_HOLD_ENABLED;
  }
}

/** Real rose-1-mini on Air Canada's recorded queue audio vs. a representative's greeting. */
async function testLiveDetectorOnRecordedQueueAudio(): Promise<void> {
  const detect = h.liveDetector.detectLiveHuman;
  const [announcement, advert, representative] = await Promise.all([
    detect({ earlierUtterances: [], latestUtterance: QUEUE_ANNOUNCEMENT }),
    detect({ earlierUtterances: [QUEUE_ANNOUNCEMENT], latestUtterance: AEROPLAN_AD }),
    detect({ earlierUtterances: [QUEUE_ANNOUNCEMENT, AEROPLAN_AD], latestUtterance: REP_GREETING }),
  ]);
  for (const result of [announcement, advert, representative]) {
    assert.doesNotMatch(result.reason, /^detector_error/, result.reason);
  }
  assert.equal(announcement.live_human, false, announcement.reason);
  assert.equal(advert.live_human, false, advert.reason);
  assert.equal(representative.live_human, true, representative.reason);
}

export const EDGE_CASES: Array<[string, () => Promise<void>]> = [
  ['twiml: redirect reopens stream until limit', testRedirectReopensStreamUntilLimit],
  ['ceiling: hold ends at max duration', testHoldEndsAtMaxDuration],
  ['status callback: Twilio status mapping', testTwilioStatusMapping],
  ['status: lost callback reconciles from Twilio', testLostStatusCallbackReconcilesFromTwilio],
  ['failures: placement errors end the session', testPlacementFailuresEndTheSession],
  ['failures: park redirect error keeps call connected', testParkFailureKeepsTheCallConnected],
  ['failures: resume error stays on hold', testResumeFailureStaysOnHold],
  ['kill switch: direct Vapi call', testKillSwitchPlacesDirectVapiCall],
  ['live detector: recorded Air Canada queue audio', testLiveDetectorOnRecordedQueueAudio],
];
