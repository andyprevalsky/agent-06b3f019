/**
 * Provider-shaped Vapi + Twilio REST responses for test fakes (test-only).
 * Shared by the isolated backend's loopback fake (routesBlackboxFakeUpstream.ts)
 * and the in-process phone-hold FakeUpstream. Imports no config, so importing it
 * never freezes VAPI_API_BASE_URL before a harness points it at its fake.
 */
import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;

export interface FakePhoneUpstreamState {
  vapiCalls: Map<string, Json>;
  twilioStatuses: Map<string, string>;
}

export interface FakePhoneUpstreamRequest {
  method: string;
  path: string;
  body: string;
}

function createVapiCall(
  state: FakePhoneUpstreamState,
  request: FakePhoneUpstreamRequest
): [number, unknown] {
  const body = JSON.parse(request.body) as Json;
  const id = `vapi-${randomUUID()}`;
  state.vapiCalls.set(id, { id, status: 'queued' });
  if (body.phoneCallProviderBypassEnabled !== true) return [201, { id, status: 'queued' }];
  return [
    201,
    {
      id,
      status: 'queued',
      phoneCallProviderDetails: {
        twiml: `<Response><Connect><Stream url="wss://phone.vapi.example/${id}"/></Connect></Response>`,
      },
    },
  ];
}

/** Provider-shaped response for one Vapi or Twilio REST request. */
export function respondFakePhoneUpstream(
  state: FakePhoneUpstreamState,
  request: FakePhoneUpstreamRequest
): [number, unknown] {
  if (request.path === '/call' && request.method === 'POST') {
    return createVapiCall(state, request);
  }
  const vapiGet = /^\/call\/([^/?]+)$/.exec(request.path);
  if (vapiGet !== null && request.method === 'GET') {
    const call = state.vapiCalls.get(vapiGet[1]);
    return call === undefined ? [404, { error: 'not found' }] : [200, call];
  }
  const vapiRecording = /^\/call\/([^/?]+)\/mono-recording$/.exec(request.path);
  if (vapiRecording !== null && request.method === 'GET') {
    const call = state.vapiCalls.get(vapiRecording[1]);
    return call?.status === 'ended'
      ? [200, { recordingOf: vapiRecording[1] }]
      : [404, { error: 'no recording' }];
  }
  if (request.path.endsWith('/Calls.json') && request.method === 'POST') {
    const sid = `CA${randomUUID().replace(/-/g, '')}`;
    state.twilioStatuses.set(sid, 'queued');
    return [201, { sid, status: 'queued' }];
  }
  const twilioCall = /\/Calls\/(CA[0-9a-f]+)\.json$/.exec(request.path);
  if (twilioCall !== null) {
    const sid = twilioCall[1];
    if (request.method === 'POST' && new URLSearchParams(request.body).get('Status') !== null) {
      state.twilioStatuses.set(sid, 'completed');
    }
    return [200, { sid, status: state.twilioStatuses.get(sid) ?? 'in-progress' }];
  }
  return [404, { error: `unexpected ${request.method} ${request.path}` }];
}
