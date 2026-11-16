/**
 * Client for the isolated backend's loopback fake Vapi/Twilio upstream
 * (/api/test/fake-phone-upstream, domains/vapi/routesBlackboxFakeUpstream.ts),
 * used by vapi.blackbox.ts to assert the exact provider requests without ever
 * reaching api.vapi.ai or api.twilio.com.
 */
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const FAKE_UPSTREAM_URL = `${BASE_URL}/api/test/fake-phone-upstream`;

async function request(url: string): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url);
  const ct = response.headers.get('content-type');
  const data: unknown = ct?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

export interface FakeUpstreamRequest {
  id: number;
  method: string;
  path: string;
  body: string;
  authorizationScheme: string | null;
  responseStatus: number;
}

export interface OutboundVapiCall {
  phoneNumberId?: string;
  customer?: { number?: string };
  phoneCallProviderBypassEnabled?: boolean;
  assistant?: {
    name?: string;
    model?: {
      provider?: string;
      model?: string;
      messages?: { role?: string; content?: string }[];
      tools?: { type?: string; function?: { name?: string }; server?: { url?: string } }[];
    };
    voice?: { provider?: string; voiceId?: string };
    transcriber?: {
      provider?: string;
      model?: string;
      language?: string;
      eotThreshold?: number;
      eotTimeoutMs?: number;
    };
    firstMessage?: string;
    endCallMessage?: string;
    silenceTimeoutSeconds?: number;
    maxDurationSeconds?: number;
    analysisPlan?: {
      summaryPlan?: { enabled?: boolean };
      successEvaluationPlan?: { enabled?: boolean };
      structuredDataPlan?: { enabled?: boolean; schema?: unknown };
    };
    serverMessages?: string[];
    clientMessages?: string[];
  };
}

/**
 * Guard: refuse to run any call-placing case unless the backend's effective
 * Vapi and Twilio base URLs route to its loopback fake with the fake key. A dev
 * or deploy backend that loaded the real VAPI_PRIVATE_KEY would otherwise dial
 * every number below for real.
 */
export async function testGuard_phoneUpstreamIsLocalFake() {
  const res = await request(`${FAKE_UPSTREAM_URL}/__status`);
  assertStatus(res.status, 200, res.data);
  const status = res.data as {
    vapiBaseUrl: string;
    twilioBaseUrl: string;
    vapiRoutesToFake: boolean;
    twilioRoutesToFake: boolean;
    vapiKeyIsFake: boolean;
  };
  if (!status.vapiRoutesToFake || !status.twilioRoutesToFake || !status.vapiKeyIsFake) {
    throw new Error(
      `Refusing to place calls: backend Vapi/Twilio upstream is not the loopback fake ` +
        `(vapi=${status.vapiBaseUrl}, twilio=${status.twilioBaseUrl}, fakeKey=${status.vapiKeyIsFake})`
    );
  }
}

export async function fakeCursor(): Promise<number> {
  const res = await request(`${FAKE_UPSTREAM_URL}/__requests?after=${Number.MAX_SAFE_INTEGER}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { nextId: number }).nextId - 1;
}

export async function fakeRequestsAfter(cursor: number): Promise<FakeUpstreamRequest[]> {
  const res = await request(`${FAKE_UPSTREAM_URL}/__requests?after=${cursor}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { requests: FakeUpstreamRequest[] }).requests;
}

/** The single POST /call the fake received whose system prompt contains `marker`. */
export async function fakeVapiCreate(
  cursor: number,
  marker: string
): Promise<{ request: FakeUpstreamRequest; body: OutboundVapiCall }> {
  const creates = (await fakeRequestsAfter(cursor))
    .filter((r) => r.method === 'POST' && r.path === '/call')
    .map((r) => ({ request: r, body: JSON.parse(r.body) as OutboundVapiCall }))
    .filter(({ body }) =>
      body.assistant?.model?.messages?.some(
        (m) => m.role === 'system' && m.content?.includes(marker) === true
      )
    );
  if (creates.length !== 1) {
    throw new Error(
      `Expected the fake Vapi upstream to receive 1 create for "${marker}", got ${creates.length}`
    );
  }
  const { request: received } = creates[0];
  if (received.authorizationScheme !== 'Bearer') {
    throw new Error(
      `Expected Bearer Authorization on Vapi create, got ${received.authorizationScheme}`
    );
  }
  return creates[0];
}

/** The route returned the fake upstream's call id. */
export function assertVapiCallPlaced(res: { status: number; data: unknown }): void {
  assertStatus(res.status, 200, res.data);
  const callId = (res.data as { call_id?: unknown }).call_id;
  if (typeof callId !== 'string' || !callId.startsWith('vapi-')) {
    throw new Error(`Expected fake upstream call id, got ${JSON.stringify(res.data)}`);
  }
}
