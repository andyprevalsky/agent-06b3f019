#!/usr/bin/env tsx
/**
 * Black-box tests for wait_for_human hold parking (domains/vapi hold*).
 *
 *   initiateCall ──▶ Vapi bypass segment + Twilio call ──wait_for_human──▶ hold stream
 *        ▲                                                                    │ STT → detector
 *        └── getCallStatus (composite) ◀── new Vapi segment ◀── live person ──┘
 *
 * Domain surface (the vapi router, mounted as server.ts mounts it):
 *   POST /api/vapi/hold/tool           — Vapi wait_for_human webhook (HMAC session token)
 *   POST /api/vapi/hold/twilio/status  — Twilio status callback
 *   POST /api/vapi/hold/twilio/twiml   — hold stream <Redirect> fallback
 *   WS   /api/vapi/hold/stream         — Twilio <Connect><Stream> media
 *   service.initiateCall / getCallStatus — the agent tool's call + poll path
 *
 * Vapi and Twilio REST are a local fake upstream; the realtime transcriber and
 * the detector are scripted so each transition is deterministic. The real
 * rose-1-mini detector is exercised on recorded Air Canada queue audio
 * (phone-hold-edges.cases.ts).
 *
 * Invariants covered:
 *   - auth boundary: every webhook and the stream refuse a bad session token
 *   - kill switch: PHONE_HOLD_ENABLED=0 places a direct Vapi call with no hold tool
 *   - idempotency: retried placement / wait_for_human webhooks place and park once
 *   - state machine: connected → on_hold → reconnecting → connected → ended, CAS-guarded
 *   - stale segment: a superseded Vapi segment cannot park the call again
 *   - resume context: the new segment carries the prior conversation, hold marker
 *     and the live person's words; analysis covers the whole call
 *   - stream resilience: STT reconnects with backoff; Twilio redirect re-opens the
 *     stream until the reconnect limit, then hangs up
 *   - ceilings: holds end at HOLD_MAX_SECONDS; Twilio TimeLimit exceeds the hold ceiling
 *   - failure surface: Vapi/Twilio placement errors end the session; park/resume
 *     failures leave the call where it was
 *   - lost callback: a poll reconciles the line status from Twilio
 *
 * Usage:
 *   bash scripts/run-blackbox-tests.sh phone-hold
 */
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { config } from 'dotenv';
import { TwilioMediaStreamClient, parseHoldTwiml, waitFor } from './phone-hold.fixtures';
import {
  CALLEE,
  BRIEF,
  HANGUP,
  QUEUE_ANNOUNCEMENT,
  REP_GREETING,
  RUN_AGENT_ID,
  SCHEMA,
  asJson,
  cleanupHarness,
  endedVapiSegment,
  h,
  loadSession,
  openStream,
  park,
  placeCall,
  postForm,
  postTool,
  setupHarness,
  streamUrl,
  toolUrlOf,
  type Json,
  type PlacedCall,
} from './phone-hold.support';

config();

interface Lifecycle {
  placed?: PlacedCall;
  holdTwiml?: string;
  resumedVapiCallId?: string;
}

const lifecycle: Lifecycle = {};

function placedCall(): PlacedCall {
  assert.ok(lifecycle.placed, 'lifecycle call was placed');
  return lifecycle.placed;
}

function holdTwiml(): string {
  assert.ok(lifecycle.holdTwiml, 'lifecycle call was parked');
  return lifecycle.holdTwiml;
}

function resumedVapiCallId(): string {
  assert.ok(lifecycle.resumedVapiCallId, 'lifecycle call was resumed');
  return lifecycle.resumedVapiCallId;
}

async function testPlacementIsHoldCapable(): Promise<void> {
  const placed = await placeCall('lifecycle');
  lifecycle.placed = placed;
  const body = placed.vapiBody;
  assert.equal(body.phoneCallProviderBypassEnabled, true);
  assert.deepEqual(body.customer, { number: CALLEE });
  assert.equal(asJson(asJson(body.assistant).model).model, 'gpt-4.1-mini');
  assert.match(placed.toolUrl, /^https:\/\/hold\.example\.test\/api\/vapi\/hold\/tool\?session=/);
  const pool = h.vapiConfig.OUTBOUND_PHONE_NUMBER_POOL.find((p) => p.id === body.phoneNumberId);
  assert.ok(pool, 'Vapi segment uses a pool number');

  const twilio = h.upstream.twilioCreates().slice(-1)[0];
  assert.equal(twilio.get('To'), CALLEE);
  assert.equal(twilio.get('From'), pool.number, 'Twilio dials from the same pool number');
  assert.match(twilio.get('Twiml') ?? '', new RegExp(`phone\\.vapi\\.example/${placed.callId}`));
  assert.match(twilio.get('StatusCallback') ?? '', /\/api\/vapi\/hold\/twilio\/status\?session=/);
  assert.equal(twilio.get('TimeLimit'), String(h.vapiConfig.HOLD_MAX_SECONDS + 3600));

  assert.equal(placed.session.state, 'connected');
  assert.equal(placed.session.agentId, RUN_AGENT_ID);
  assert.equal(placed.session.activeVapiCallId, placed.callId);
  assert.equal(placed.session.segments.length, 1);
}

async function testPlacementRetryIsIdempotent(): Promise<void> {
  const placed = placedCall();
  const vapiCreates = h.upstream.vapiCreates().length;
  const twilioCreates = h.upstream.twilioCreates().length;
  const retry = await h.service.initiateCall({
    to: CALLEE,
    system_prompt: BRIEF,
    output_schema: SCHEMA,
    idempotency_key: `${RUN_AGENT_ID}:lifecycle`,
  });
  assert.equal(retry.call_id, placed.callId);
  assert.equal(h.upstream.vapiCreates().length, vapiCreates, 'no second Vapi segment');
  assert.equal(h.upstream.twilioCreates().length, twilioCreates, 'no second Twilio call');
}

async function testStatusBeforeHoldShowsLiveMonitor(): Promise<void> {
  const placed = placedCall();
  const monitor = { listenUrl: 'wss://listen.vapi.example/seg-1' };
  h.upstream.vapiCalls.set(placed.callId, {
    id: placed.callId,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    monitor,
  });
  const status = await h.service.getCallStatus(placed.callId);
  assert.equal(status.status, 'in-progress');
  assert.deepEqual(status.monitor, monitor);
  assert.equal(asJson(status.phoneHold).state, 'connected');
}

async function testWebhooksRefuseBadTokensAndHonorKillSwitch(): Promise<void> {
  const placed = placedCall();
  const forged = placed.toolUrl.replace(/token=[^&]+/, 'token=forged');
  assert.equal((await postTool(forged, placed.callId)).status, 403);
  const statusForged = await postForm(
    `https://hold.example.test/api/vapi/hold/twilio/status?session=${placed.session.id}&token=x`,
    { CallStatus: 'completed' }
  );
  assert.equal(statusForged.status, 403);

  process.env.PHONE_HOLD_ENABLED = '0';
  try {
    assert.equal((await postTool(placed.toolUrl, placed.callId)).status, 503);
  } finally {
    delete process.env.PHONE_HOLD_ENABLED;
  }
  assert.equal((await loadSession(placed.session.id)).state, 'connected');
}

async function testWaitForHumanParksTheCallOnce(): Promise<void> {
  const placed = placedCall();
  const sid = placed.session.twilioCallSid ?? '';
  lifecycle.holdTwiml = await park(placed);
  const parsed = parseHoldTwiml(lifecycle.holdTwiml);
  assert.equal(parsed.streamUrl, 'wss://hold.example.test/api/vapi/hold/stream');
  assert.equal(parsed.parameters.session, placed.session.id);
  assert.ok((parsed.parameters.token ?? '') !== '', 'stream carries the session token');
  assert.match(
    parsed.redirectUrl,
    /^https:\/\/hold\.example\.test\/api\/vapi\/hold\/twilio\/twiml/
  );

  const session = await loadSession(placed.session.id);
  assert.equal(session.state, 'on_hold');
  assert.equal(session.holds.length, 1);
  assert.equal(session.holds[0].heard, 'The wait time may exceed two hours.');

  const retry = await postTool(placed.toolUrl, placed.callId);
  assert.match(retry.results[0]?.result ?? '', /You are on hold/);
  assert.equal(h.upstream.twilioUpdates(sid).length, 1, 'retried webhook does not redirect again');
}

async function testStatusWhileOnHoldCachesTheFinishedSegment(): Promise<void> {
  const placed = placedCall();
  h.upstream.vapiCalls.set(
    placed.callId,
    endedVapiSegment(placed.callId, {
      endedReason: 'customer-ended-call',
      cost: 0.05,
      transcript: 'User: Welcome to Air Canada. Please hold to speak to an agent.',
      analysis: { summary: 'Reached the Air Canada hold queue.' },
      artifact: {
        messagesOpenAIFormatted: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'Welcome to Air Canada. Please hold to speak to an agent.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc-1',
                type: 'function',
                function: { name: 'wait_for_human', arguments: '{"heard":"two hours"}' },
              },
            ],
          },
        ],
      },
    })
  );
  const status = await h.service.getCallStatus(placed.callId);
  assert.equal(status.status, 'in-progress');
  assert.equal(status.monitor, undefined, 'no live monitor while parked');
  const phoneHold = asJson(status.phoneHold);
  assert.equal(phoneHold.state, 'on_hold');
  assert.equal((phoneHold.holds as Json[]).length, 1);
  const session = await loadSession(placed.session.id);
  assert.ok(session.segments[0].final, 'the finished segment is cached for later polls');
}

async function testStreamRefusesBadTokens(): Promise<void> {
  const client = new TwilioMediaStreamClient(streamUrl());
  await client.open();
  client.start('CAforged', { session: placedCall().session.id, token: 'forged' });
  assert.equal(await client.closed, 1008);
}

function assertResumedAssistant(resumeBody: Json, toolUrl: string): void {
  assert.equal(resumeBody.phoneCallProviderBypassEnabled, true);
  const assistant = asJson(resumeBody.assistant);
  assert.equal(assistant.firstMessageMode, 'assistant-speaks-first-with-model-generated-message');
  assert.equal(assistant.firstMessage, undefined);
  const messages = asJson(assistant.model).messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 3);
  assert.match(messages[0].content, /You are making an outbound phone call/);
  assert.match(messages[1].content, /Callee: Welcome to Air Canada/);
  assert.match(messages[1].content, /You went on hold\./);
  assert.match(messages[1].content, /\[On hold for \d+s; the line played: "Your call may be/);
  assert.match(messages[1].content, /just been reconnected because a live person picked up/);
  assert.deepEqual(messages[2], { role: 'user', content: REP_GREETING });
  assert.equal(toolUrlOf(resumeBody), toolUrl, 'resumed segment can hold again');
  const analysis = asJson(assistant.analysisPlan);
  const summaryMessages = asJson(analysis.summaryPlan).messages as Array<{ content: string }>;
  assert.match(
    summaryMessages[1].content,
    /Callee: Welcome to Air Canada[\s\S]*\{\{transcript\}\}/
  );
  assert.deepEqual(asJson(analysis.structuredDataPlan).schema, SCHEMA);
}

async function testLivePersonResumesTheCall(): Promise<void> {
  const placed = placedCall();
  const sid = placed.session.twilioCallSid ?? '';
  const createdBefore = h.transcribers.created.length;
  const client = await openStream(holdTwiml(), sid);
  const first = await waitFor('hold transcriber', () => h.transcribers.created[createdBefore]);

  for (let frame = 0; frame < 13; frame++) client.sendFrame();
  await waitFor('one 200 ms batch', () => first.sent.length === 1);
  assert.equal(first.sent[0].length, 1600, 'Twilio 20 ms frames batch into 200 ms');

  first.commit(QUEUE_ANNOUNCEMENT);
  await waitFor('hold utterance recorded', async () => {
    const session = await loadSession(placed.session.id);
    return session.holds[0].utterances.length === 1;
  });
  assert.equal((await loadSession(placed.session.id)).state, 'on_hold', 'hold audio keeps holding');

  first.drop(new Error('stt socket reset'));
  const second = await waitFor(
    'STT reconnect',
    () => h.transcribers.created[createdBefore + 1],
    4_000
  );

  h.detector.markLivePerson(REP_GREETING);
  const vapiCreates = h.upstream.vapiCreates().length;
  second.commit(REP_GREETING);
  const resumed = await waitFor('resumed session', async () => {
    const session = await loadSession(placed.session.id);
    return session.state === 'connected' ? session : null;
  });
  const lastDetection = h.detector.calls[h.detector.calls.length - 1];
  assert.deepEqual(lastDetection.earlierUtterances, [QUEUE_ANNOUNCEMENT]);
  await waitFor('listener stops once the call resumes', () => second.closed);

  const resumeBody = h.upstream.vapiCreates()[vapiCreates];
  assert.ok(resumeBody, 'resume created a new Vapi segment');
  assertResumedAssistant(resumeBody, placed.toolUrl);

  const resumedId = resumed.activeVapiCallId ?? '';
  lifecycle.resumedVapiCallId = resumedId;
  const updates = h.upstream.twilioUpdates(sid);
  assert.match(updates[updates.length - 1].get('Twiml') ?? '', new RegExp(resumedId));
  assert.equal(resumed.segments.length, 2);
  assert.equal(resumed.segments[1].vapiCallId, resumedId);
  assert.ok(resumed.holds[0].endedAt);
  assert.equal(resumed.holds[0].humanUtterance, REP_GREETING);
  assert.deepEqual(
    resumed.holds[0].utterances.map((utterance) => utterance.liveHuman),
    [false, true]
  );
  client.close();
}

async function testSupersededSegmentCannotPark(): Promise<void> {
  const placed = placedCall();
  const response = await postTool(placed.toolUrl, placed.callId);
  assert.match(response.results[0]?.result ?? '', /no longer active/);
  assert.equal((await loadSession(placed.session.id)).state, 'connected');
}

async function testStatusAfterResumeMergesSegments(): Promise<void> {
  const placed = placedCall();
  const resumedId = resumedVapiCallId();
  const monitor = { listenUrl: 'wss://listen.vapi.example/seg-2' };
  h.upstream.vapiCalls.set(resumedId, {
    id: resumedId,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    transcript: 'User: How can I help you today?\nAI: I would like to claim my flight credit.',
    monitor,
  });
  const status = await h.service.getCallStatus(placed.callId);
  assert.equal(status.id, placed.callId, 'the root Vapi id stays the call id');
  assert.equal(status.status, 'in-progress');
  assert.deepEqual(status.monitor, monitor, 'monitor follows the live segment');
  const transcript = String(status.transcript);
  const holdAt = transcript.indexOf('[On hold for');
  assert.ok(holdAt > transcript.indexOf('Welcome to Air Canada'), transcript);
  assert.ok(transcript.indexOf('claim my flight credit') > holdAt, transcript);
}

async function testReconnectTwimlHangsUpOnceConnected(): Promise<void> {
  const response = await postForm(parseHoldTwiml(holdTwiml()).redirectUrl, { CallSid: 'x' });
  assert.equal(await response.text(), HANGUP);
}

async function testCallEndMergesFinalAnalysis(): Promise<void> {
  const placed = placedCall();
  const resumedId = resumedVapiCallId();
  const structuredData = { credit_amount: 'CAD 412.00' };
  h.upstream.vapiCalls.set(
    resumedId,
    endedVapiSegment(resumedId, {
      endedReason: 'assistant-ended-call',
      cost: 0.1,
      transcript: 'User: How can I help you today?\nAI: I would like to claim my flight credit.',
      analysis: { summary: 'Claimed a CAD 412 flight credit.', structuredData },
    })
  );
  const statusUrl = h.upstream
    .twilioCreates()
    .map((form) => form.get('StatusCallback') ?? '')
    .find((url) => url.includes(placed.session.id));
  assert.ok(statusUrl, 'Twilio was given this session status callback');
  const callback = await postForm(statusUrl, {
    CallStatus: 'completed',
    CallSid: placed.session.twilioCallSid ?? '',
  });
  assert.equal(callback.status, 204);
  const session = await loadSession(placed.session.id);
  assert.equal(session.state, 'ended');
  assert.equal(session.endedReason, null);

  const status = await h.service.getCallStatus(placed.callId);
  assert.equal(status.status, 'ended');
  assert.equal(status.endedReason, 'assistant-ended-call');
  assert.deepEqual(asJson(status.analysis).structuredData, structuredData);
  assert.ok(Math.abs(Number(status.cost) - 0.15) < 1e-9, `summed cost ${String(status.cost)}`);
  const phoneHold = asJson(status.phoneHold);
  assert.equal(phoneHold.state, 'ended');
  assert.equal((phoneHold.segments as Json[]).length, 2);
  assert.equal(phoneHold.assistantSeconds, 120);

  const lateStream = await openStream(holdTwiml(), placed.session.twilioCallSid ?? '');
  assert.equal(await lateStream.closed, 1008, 'an ended call refuses a hold stream');
}

const LIFECYCLE_CASES: Array<[string, () => Promise<void>]> = [
  ['placement: bypass segment + Twilio call with hold tool', testPlacementIsHoldCapable],
  ['placement: idempotent retry places nothing new', testPlacementRetryIsIdempotent],
  ['status: live monitor before hold', testStatusBeforeHoldShowsLiveMonitor],
  ['webhooks: bad tokens and kill switch', testWebhooksRefuseBadTokensAndHonorKillSwitch],
  ['wait_for_human: parks the call once', testWaitForHumanParksTheCallOnce],
  ['status: on hold, finished segment cached', testStatusWhileOnHoldCachesTheFinishedSegment],
  ['stream: bad token refused', testStreamRefusesBadTokens],
  ['stream: hold audio holds, STT reconnects, live person resumes', testLivePersonResumesTheCall],
  ['wait_for_human: superseded segment cannot park', testSupersededSegmentCannotPark],
  ['status: segments merge after resume', testStatusAfterResumeMergesSegments],
  ['twiml: reconnect after resume hangs up', testReconnectTwimlHangsUpOnceConnected],
  ['status: call end merges final analysis', testCallEndMergesFinalAnalysis],
];

async function main(): Promise<void> {
  await setupHarness();
  const { EDGE_CASES } = await import('./phone-hold-edges.cases');
  const cases = [...LIFECYCLE_CASES, ...EDGE_CASES];
  const failures: string[] = [];
  try {
    // Sequential: the lifecycle cases walk one call through its states.
    for (const [name, fn] of cases) {
      const started = Date.now();
      try {
        await fn();
        console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
        console.log(`  FAIL  ${name} -- ${message} (${Date.now() - started}ms)`);
      }
    }
  } finally {
    await cleanupHarness();
  }
  console.log(`\n${cases.length - failures.length}/${cases.length} phone-hold tests passed`);
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nALL PHONE-HOLD BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
