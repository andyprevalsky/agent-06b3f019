/**
 * Shared harness for phone-hold.blackbox.ts and phone-hold-edges.cases.ts: the
 * vapi router and hold stream server on a local port, wired to the fake
 * Vapi/Twilio upstream and the scripted transcriber/detector.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type * as VapiConfig from '../../domains/vapi/config';
import type * as HoldDetector from '../../domains/vapi/holdDetectorService';
import type * as HoldService from '../../domains/vapi/holdService';
import type * as HoldStatus from '../../domains/vapi/holdStatusService';
import type * as HoldRepo from '../../domains/vapi/repoHold';
import type * as VapiService from '../../domains/vapi/service';
import type { PhoneCallSessionRecord } from '../../domains/vapi/types';
import {
  FakeTranscribers,
  FakeUpstream,
  ScriptedDetector,
  TwilioMediaStreamClient,
  parseHoldTwiml,
} from './phone-hold.fixtures';

export type Json = Record<string, unknown>;

export const RUN_AGENT_ID = randomUUID();
export const CALLEE = '+15555550142';
export const BRIEF =
  'Call Air Canada and claim the unused-ticket flight credit for booking ABC123. If you land in a hold queue, wait for a live agent.';
export const SCHEMA = { type: 'object', properties: { credit_amount: { type: 'string' } } };
export const HANGUP = '<Response><Hangup/></Response>';

// Recorded on Air Canada's line (call 5, 2026-10-06) and transcribed by ElevenLabs Scribe.
export const QUEUE_ANNOUNCEMENT =
  'Your call may be recorded for coaching and record-keeping purposes as outlined in our privacy policy. The wait time to speak with us may exceed two hours. Please hold to speak to an agent.';
export const AEROPLAN_AD =
  'For 40 years, Aeroplan has taken members to unbelievable destinations, unlocked extraordinary experiences, and helped them discover a world of rewards. Aeroplan: travel more, travel better.';
export const REP_GREETING =
  "Hi, thanks for holding, you've reached Air Canada, my name is Dana. How can I help you today?";

export interface HoldHarness {
  upstream: FakeUpstream;
  transcribers: FakeTranscribers;
  detector: ScriptedDetector;
  baseUrl: string;
  server: http.Server;
  vapiConfig: typeof VapiConfig;
  service: typeof VapiService;
  holdService: typeof HoldService;
  holdStatus: typeof HoldStatus;
  repo: typeof HoldRepo;
  liveDetector: typeof HoldDetector;
  prisma: PrismaClient;
}

/** Populated by {@link setupHarness}; modules load only after the env points at the fakes. */
export const h = {
  upstream: new FakeUpstream(),
  transcribers: new FakeTranscribers(),
  detector: new ScriptedDetector(),
} as HoldHarness;

export async function setupHarness(): Promise<void> {
  await h.upstream.start();
  Object.assign(process.env, {
    VAPI_API_BASE_URL: h.upstream.url,
    VAPI_PRIVATE_KEY: 'vapi-blackbox-key',
    TWILIO_API_BASE_URL: h.upstream.url,
    TWILIO_ACCOUNT_SID: 'ACblackbox',
    TWILIO_AUTH_TOKEN: 'twilio-blackbox-token',
    ELEVENLABS_API_KEY: 'elevenlabs-blackbox-key',
    PHONE_HOLD_PUBLIC_URL: 'https://hold.example.test',
    TRACE_ARCHIVE_ENABLED: '0',
  });
  if ((process.env.BACKEND_API_KEY ?? '') === '') process.env.BACKEND_API_KEY = 'hold-blackbox';
  delete process.env.PHONE_HOLD_ENABLED;
  delete process.env.PHONE_HOLD_MAX_SECONDS;

  h.vapiConfig = await import('../../domains/vapi/config');
  h.service = await import('../../domains/vapi/service');
  h.holdService = await import('../../domains/vapi/holdService');
  h.holdStatus = await import('../../domains/vapi/holdStatusService');
  h.repo = await import('../../domains/vapi/repoHold');
  h.liveDetector = await import('../../domains/vapi/holdDetectorService');
  h.prisma = (await import('../../providers/database')).prisma;
  const vapiRoutes = (await import('../../domains/vapi/routes')).default;
  const { attachHoldStreamServer } = await import('../../domains/vapi/holdListenerService');

  const app = express();
  app.use(express.json());
  app.use('/api/vapi', vapiRoutes);
  h.server = http.createServer(app);
  attachHoldStreamServer(h.server, {
    transcriberFactory: () => h.transcribers.factory,
    detector: h.detector.detect,
  });
  await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', resolve));
  h.baseUrl = `http://127.0.0.1:${(h.server.address() as AddressInfo).port}`;
}

export async function cleanupHarness(): Promise<void> {
  await h.prisma.phoneCallSession.deleteMany({ where: { agentId: RUN_AGENT_ID } });
  await h.prisma.toolSideEffect.deleteMany({
    where: { operationKey: { startsWith: `vapi.outbound_call:${RUN_AGENT_ID}:` } },
  });
  await h.prisma.$disconnect();
  h.server.closeAllConnections();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  await h.upstream.stop();
}

// ==================== HELPERS ====================

export function asJson(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** A public webhook URL handed to Twilio/Vapi, re-pointed at the local server. */
export function local(url: string): string {
  const parsed = new URL(url);
  return `${h.baseUrl}${parsed.pathname}${parsed.search}`;
}

export function streamUrl(): string {
  return `${h.baseUrl.replace(/^http:/, 'ws:')}${h.vapiConfig.HOLD_STREAM_PATH}`;
}

export function resolveConfig(): VapiConfig.HoldRuntimeConfig {
  const resolved = h.vapiConfig.resolveHoldRuntimeConfig();
  assert.ok(resolved, 'hold runtime config resolves in the test env');
  return resolved;
}

export function toolUrlOf(vapiBody: Json): string {
  const tools = asJson(asJson(vapiBody.assistant).model).tools as Json[];
  const tool = tools.find((entry) => asJson(entry.function).name === 'wait_for_human');
  assert.ok(tool, 'assistant has the wait_for_human tool');
  return String(asJson(tool.server).url);
}

export async function loadSession(id: string): Promise<PhoneCallSessionRecord> {
  const session = await h.repo.findPhoneCallSession(id);
  assert.ok(session, `session ${id} exists`);
  return session;
}

export interface PlacedCall {
  callId: string;
  session: PhoneCallSessionRecord;
  vapiBody: Json;
  toolUrl: string;
}

let labelCounter = 0;

export async function placeCall(label = `call-${++labelCounter}`): Promise<PlacedCall> {
  const creates = h.upstream.vapiCreates().length;
  const result = await h.service.initiateCall({
    to: CALLEE,
    system_prompt: BRIEF,
    output_schema: SCHEMA,
    idempotency_key: `${RUN_AGENT_ID}:${label}`,
  });
  const session = await h.repo.findPhoneCallSessionByRootVapiCallId(result.call_id);
  assert.ok(session, 'placement created a session');
  const vapiBody = h.upstream.vapiCreates()[creates];
  return { callId: result.call_id, session, vapiBody, toolUrl: toolUrlOf(vapiBody) };
}

export async function postTool(
  toolUrl: string,
  vapiCallId: string
): Promise<{ status: number; results: Array<{ toolCallId: string; result: string }> }> {
  const response = await fetch(local(toolUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        call: { id: vapiCallId },
        toolCallList: [
          {
            id: `tc-${randomUUID()}`,
            type: 'function',
            function: {
              name: 'wait_for_human',
              arguments: JSON.stringify({ heard: 'The wait time may exceed two hours.' }),
            },
          },
        ],
      },
    }),
  });
  const body = asJson(await response.json());
  const results = Array.isArray(body.results)
    ? (body.results as Array<{ toolCallId: string; result: string }>)
    : [];
  return { status: response.status, results };
}

export async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(local(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

/** Parks a placed call and returns the hold TwiML Twilio was redirected to. */
export async function park(placed: PlacedCall): Promise<string> {
  const sid = placed.session.twilioCallSid ?? '';
  const before = h.upstream.twilioUpdates(sid).length;
  const response = await postTool(placed.toolUrl, placed.callId);
  assert.equal(response.status, 200);
  assert.match(response.results[0]?.result ?? '', /reconnected when a live person picks up/);
  const updates = h.upstream.twilioUpdates(sid);
  assert.equal(updates.length, before + 1, 'parking redirects the Twilio call once');
  return updates[updates.length - 1].get('Twiml') ?? '';
}

/** Plays Twilio opening the hold stream that the hold TwiML points at. */
export async function openStream(
  holdTwiml: string,
  callSid: string
): Promise<TwilioMediaStreamClient> {
  const { parameters } = parseHoldTwiml(holdTwiml);
  const client = new TwilioMediaStreamClient(streamUrl());
  await client.open();
  client.start(callSid, parameters);
  return client;
}

export function endedVapiSegment(id: string, extra: Json): Json {
  return {
    id,
    status: 'ended',
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    endedAt: new Date(Date.now() - 30_000).toISOString(),
    ...extra,
  };
}
