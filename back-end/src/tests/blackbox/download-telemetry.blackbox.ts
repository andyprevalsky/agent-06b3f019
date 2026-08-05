#!/usr/bin/env tsx
/**
 * Black-box coverage for authenticated Mac updater download telemetry.
 *
 * Critical path:
 * Electron updater -> POST /api/download-telemetry -> validation ->
 * structured backend log -> Amplitude HTTP V2 ingestion.
 */

import { config } from 'dotenv';

config();

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const AMPLITUDE_INGEST_URL =
  process.env.AMPLITUDE_INGEST_URL ?? 'https://api2.amplitude.com/2/httpapi';
const AMPLITUDE_API_KEY = process.env.AMPLITUDE_API_KEY ?? '';

interface TestContext {
  accessToken: string;
  userId: string;
}

interface Capture {
  url: string;
  method: string;
  requestBody: string | null;
  captureToken: string | null;
}

const tests: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];

function test(name: string, run: (context: TestContext) => Promise<void>): void {
  tests.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? ((await response.json()) as unknown)
    : await response.text();
  return { status: response.status, data };
}

async function setup(): Promise<TestContext> {
  const response = await request('/api/auth/anonymous', { method: 'POST' });
  assert(response.status === 200, `anonymous auth failed: ${JSON.stringify(response.data)}`);
  const data = response.data as {
    session?: { access_token?: string };
    user?: { id?: string };
  };
  assert(typeof data.session?.access_token === 'string', 'anonymous auth token missing');
  assert(typeof data.user?.id === 'string', 'anonymous user id missing');
  return { accessToken: data.session.access_token, userId: data.user.id };
}

function telemetryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'mac_update_download_completed',
    insertId: 'download-session-123:completed',
    sessionId: 'download-session-123',
    occurredAt: '2026-07-29T22:30:00.000Z',
    version: '2.4.6',
    elapsedMs: 92_000,
    bytesPerSecond: 1_660_000,
    transferredBytes: 152_852_260,
    totalBytes: 152_852_260,
    ...overrides,
  };
}

function amplitudeBody(userId: string, payload: Record<string, unknown>): string {
  const properties: Record<string, unknown> = {
    source: 'mac_auto_updater',
    session_id: payload.sessionId,
  };
  const propertyMappings: Array<[string, string]> = [
    ['version', 'version'],
    ['milestonePercent', 'milestone_percent'],
    ['elapsedMs', 'elapsed_ms'],
    ['bytesPerSecond', 'bytes_per_second'],
    ['transferredBytes', 'transferred_bytes'],
    ['totalBytes', 'total_bytes'],
    ['errorMessage', 'error_message'],
  ];
  for (const [inputKey, outputKey] of propertyMappings) {
    if (payload[inputKey] !== undefined) properties[outputKey] = payload[inputKey];
  }
  return JSON.stringify({
    api_key: AMPLITUDE_API_KEY,
    events: [
      {
        user_id: userId,
        event_type: payload.event,
        time: Date.parse(String(payload.occurredAt)),
        insert_id: payload.insertId,
        event_properties: properties,
      },
    ],
  });
}

async function seedAmplitude(body: string, status = 200): Promise<void> {
  const key = `call:${JSON.stringify([AMPLITUDE_INGEST_URL, 'POST', body])}`;
  const response = await request('/api/test/captures/cache', {
    method: 'PUT',
    body: JSON.stringify({
      key,
      value: {
        __ff_promise_result: true,
        value: {
          status,
          statusText: status === 200 ? 'OK' : 'Service Unavailable',
          body: JSON.stringify(
            status === 200 ? { code: 200, events_ingested: 1 } : { code: status }
          ),
          headers: { 'content-type': 'application/json' },
        },
      },
    }),
  });
  assert(response.status === 200, `failed to seed Amplitude fixture: ${response.status}`);
}

async function captures(token: string): Promise<Capture[]> {
  const response = await request(`/api/test/captures?token=${encodeURIComponent(token)}`);
  assert(response.status === 200, 'capture endpoint unavailable');
  return ((response.data as { captures?: Capture[] }).captures ?? []).filter(
    (capture) => capture.url === AMPLITUDE_INGEST_URL
  );
}

async function waitForCaptures(
  token: string,
  expected: number,
  deadline = Date.now() + 3_000
): Promise<Capture[]> {
  const observed = await captures(token);
  if (observed.length >= expected || Date.now() >= deadline) return observed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return waitForCaptures(token, expected, deadline);
}

test('rejects unauthenticated telemetry', async () => {
  const response = await request('/api/download-telemetry', {
    method: 'POST',
    body: JSON.stringify(telemetryPayload()),
  });
  assert(response.status === 401, `expected 401, got ${response.status}`);
});

test('rejects invalid and unbounded telemetry fields', async ({ accessToken }) => {
  const response = await request('/api/download-telemetry', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(
      telemetryPayload({
        event: 'unknown_download_event',
        errorMessage: 'x'.repeat(1000),
      })
    ),
  });
  assert(response.status === 400, `expected 400, got ${response.status}`);
  assert(
    typeof (response.data as { error?: unknown }).error === 'string',
    'invalid request must return an error string'
  );
});

test('logs and forwards a completed updater trace to Amplitude', async (context) => {
  const payload = telemetryPayload();
  const outboundBody = amplitudeBody(context.userId, payload);
  await seedAmplitude(outboundBody);
  const captureToken = `download-completed-${Date.now()}`;

  const response = await request('/api/download-telemetry', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      'X-Capture-Token': captureToken,
    },
    body: JSON.stringify(payload),
  });

  assert(response.status === 202, `expected 202, got ${response.status}`);
  assert((response.data as { accepted?: unknown }).accepted === true, 'accepted=true missing');
  const outbound = await waitForCaptures(captureToken, 1);
  assert(outbound.length === 1, `expected one Amplitude call, got ${outbound.length}`);
  assert(outbound[0].method === 'POST', 'Amplitude ingestion must use POST');
  assert(outbound[0].requestBody === outboundBody, 'Amplitude payload lost transfer diagnostics');
});

test('forwards failure diagnostics without leaking unbounded messages', async (context) => {
  const payload = telemetryPayload({
    event: 'mac_update_download_failed',
    insertId: 'download-session-456:failed',
    sessionId: 'download-session-456',
    bytesPerSecond: 320_000,
    transferredBytes: 12_000_000,
    errorMessage: 'socket reset by peer',
  });
  const outboundBody = amplitudeBody(context.userId, payload);
  await seedAmplitude(outboundBody);
  const captureToken = `download-failed-${Date.now()}`;

  const response = await request('/api/download-telemetry', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      'X-Capture-Token': captureToken,
    },
    body: JSON.stringify(payload),
  });

  assert(response.status === 202, `expected 202, got ${response.status}`);
  const outbound = await waitForCaptures(captureToken, 1);
  assert(outbound.length === 1, `expected one Amplitude call, got ${outbound.length}`);
  assert(outbound[0].requestBody === outboundBody, 'failure diagnostics did not round-trip');
});

test('accepts telemetry before retryable Amplitude delivery finishes', async (context) => {
  const payload = telemetryPayload({
    insertId: 'download-session-retry:completed',
    sessionId: 'download-session-retry',
  });
  const outboundBody = amplitudeBody(context.userId, payload);
  await seedAmplitude(outboundBody, 503);
  const captureToken = `download-retry-${Date.now()}`;

  const response = await request('/api/download-telemetry', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      'X-Capture-Token': captureToken,
    },
    body: JSON.stringify(payload),
  });
  // Sample the delivery progress the instant the response lands, before any
  // other await can let the retry sequence advance.
  const deliveredWhenAccepted = await captures(captureToken);

  assert(response.status === 202, `expected 202, got ${response.status}`);
  // The property under test is that the route ACCEPTS before the retry sequence
  // finishes — a causal ordering, not a duration. Asserting a fixed wall-clock
  // budget (previously 500ms, against 700ms of total backoff) made this fail
  // whenever the full coverage run put enough load on the host to slow an
  // ordinary round trip, which says nothing about whether the handler awaited
  // delivery. A blocking implementation can only respond once all three
  // attempts are done, so it is caught here regardless of how slow the box is.
  assert(
    deliveredWhenAccepted.length < 3,
    `202 waited for the full Amplitude retry sequence: ${deliveredWhenAccepted.length}/3 attempts had already completed when the response arrived`
  );
  const outbound = await waitForCaptures(captureToken, 3);
  assert(outbound.length === 3, `expected three Amplitude attempts, got ${outbound.length}`);
});

async function main(): Promise<void> {
  const context = await setup();
  let failures = 0;
  console.log(`\nDownload telemetry blackbox (${tests.length} cases)`);
  for (const entry of tests) {
    const startedAt = Date.now();
    try {
      await entry.run(context);
      console.log(`  ✅ ${entry.name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failures += 1;
      console.error(
        `  ❌ ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\nRESULTS: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
