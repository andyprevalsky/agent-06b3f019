/**
 * Loopback fake of the Vapi and Twilio REST upstreams (test-only).
 *
 * Mounted by server.ts only when BLACKBOX_TEST_CAPTURE_OUTBOUND=1. The backend
 * blackbox and coverage runners point VAPI_API_BASE_URL, TWILIO_API_BASE_URL and
 * VAPI_PRIVATE_KEY at this router (scripts/blackbox-phone-env.sh), so no test can
 * dial a real phone number through api.vapi.ai or api.twilio.com. The same
 * responder backs the in-process phone-hold FakeUpstream.
 *
 *   ANY /call, /call/:id, /2010-04-01/.../Calls*.json — fake provider responses
 *   GET /__status            — whether the effective Vapi/Twilio base URLs route here
 *   GET /__requests?after=N  — requests this fake received (bounded, newest kept)
 */
import { Router, type Request } from 'express';
import { TWILIO_API_BASE_URL, VAPI_BASE_URL, VAPI_PRIVATE_KEY } from './config';
import {
  respondFakePhoneUpstream,
  type FakePhoneUpstreamRequest,
  type FakePhoneUpstreamState,
} from './fakePhoneUpstreamResponder';

export const BLACKBOX_FAKE_PHONE_UPSTREAM_PATH = '/api/test/fake-phone-upstream';
export const BLACKBOX_VAPI_PRIVATE_KEY = 'vapi-blackbox-key';
const REQUEST_LOG_LIMIT = 1000;

export interface FakePhoneUpstreamRecord extends FakePhoneUpstreamRequest {
  id: number;
  /** Authorization scheme only (e.g. `Bearer`); credentials are never recorded. */
  authorizationScheme: string | null;
  responseStatus: number;
}

function rawBody(req: Request): string {
  const body: unknown = req.body;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body === undefined || body === null) return '';
  if (typeof body === 'object' && Object.keys(body).length === 0) return '';
  if (req.is('application/x-www-form-urlencoded') !== false) {
    return new URLSearchParams(body as Record<string, string>).toString();
  }
  return JSON.stringify(body);
}

/** True when `baseUrl` targets this router on the backend serving `req`. */
function routesToThisFake(baseUrl: string, req: Request): boolean {
  try {
    const target = new URL(baseUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
    return (
      target.protocol === 'http:' &&
      loopback &&
      Number(target.port) === req.socket.localPort &&
      target.pathname.replace(/\/+$/, '') === req.baseUrl
    );
  } catch {
    return false;
  }
}

export function createBlackboxFakePhoneUpstreamRouter(): Router {
  const router = Router();
  const state: FakePhoneUpstreamState = { vapiCalls: new Map(), twilioStatuses: new Map() };
  const records: FakePhoneUpstreamRecord[] = [];
  let nextId = 1;

  router.get('/__status', (req, res) => {
    res.json({
      vapiBaseUrl: VAPI_BASE_URL,
      twilioBaseUrl: TWILIO_API_BASE_URL,
      vapiRoutesToFake: routesToThisFake(VAPI_BASE_URL, req),
      twilioRoutesToFake: routesToThisFake(TWILIO_API_BASE_URL, req),
      vapiKeyIsFake: VAPI_PRIVATE_KEY === BLACKBOX_VAPI_PRIVATE_KEY,
    });
  });

  router.get('/__requests', (req, res) => {
    const after = Number(req.query.after ?? 0);
    res.json({ nextId, requests: records.filter((record) => record.id > after) });
  });

  router.use((req, res) => {
    const request = { method: req.method, path: req.path, body: rawBody(req) };
    let status: number;
    let payload: unknown;
    try {
      [status, payload] = respondFakePhoneUpstream(state, request);
    } catch (error) {
      [status, payload] = [400, { error: error instanceof Error ? error.message : String(error) }];
    }
    const authorization = req.get('authorization');
    records.push({
      id: nextId++,
      ...request,
      authorizationScheme: authorization === undefined ? null : authorization.split(' ')[0],
      responseStatus: status,
    });
    if (records.length > REQUEST_LOG_LIMIT) records.splice(0, records.length - REQUEST_LOG_LIMIT);
    res.status(status).json(payload);
  });

  return router;
}
