import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';

config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
export const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

export const QueueSuccessResponse = z.object({
  success: z.literal(true),
  queue_id: z.string(),
});

const PopMessageShape = z.object({
  id: z.string(),
  phone_number: z.string(),
  message: z.string(),
  agent_id: z.string(),
  created_at: z.string(),
  claim_token: z.string().optional(),
});

export const PopResponse = z.object({ message: PopMessageShape.nullable() });

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
}

export const ctx: TestContext = {};

export async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data: unknown = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function ackAuthHeaders(token: string): Record<string, string> {
  return {
    ...authHeaders(token),
    'X-iMessage-Delivery-Results': 'v1',
  };
}

export function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
}

export function internalRelayHeaders(): Record<string, string> {
  return {
    ...apiKeyHeaders(),
    'X-User-Id': ctx.userId!,
    'X-CloudBench-iMessage-Relay': 'v1',
    'X-iMessage-Delivery-Results': 'v1',
  };
}

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

export function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

export async function runPool(
  tests: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= tests.length) return;
      results[index] = await runTest(tests[index].name, tests[index].fn);
    }
  }
  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function setup(): Promise<void> {
  const response = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(response.status, 200, response.data);
  const data = response.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = data.session.access_token;
  ctx.userId = data.user.id;
}

export async function drainQueueForCurrentUser(): Promise<number> {
  let drained = 0;
  let errors = 0;

  async function drainNext(): Promise<number> {
    if (errors >= 10 || drained > 1000) return drained;
    const response = await request(`${BASE_URL}/api/imessage/queue/pop`, {
      headers: authHeaders(ctx.accessToken!),
    });
    if (response.status !== 200) {
      errors += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return drainNext();
    }
    const body = response.data as { message: unknown | null };
    if (!body.message) return drained;
    drained += 1;
    errors = 0;
    return drainNext();
  }

  return drainNext();
}

export async function testPopInternalKeyRequiresRelayScope(): Promise<void> {
  const response = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(response.status, 403, response.data);
}

export async function testInternalBenchmarkRelayRoundTrip(): Promise<void> {
  const unique = `Internal benchmark relay ${Date.now()}`;
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'internal-benchmark-relay-agent',
      idempotency_key: `internal-benchmark-relay-${Date.now()}`,
      phone_number: '+19729777432',
      message: unique,
    }),
  });
  assertStatus(queued.status, 200, queued.data);

  const popped = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: internalRelayHeaders(),
  });
  assertStatus(popped.status, 200, popped.data);
  const message = (
    popped.data as { message: { id: string; message: string; claim_token: string } | null }
  ).message;
  if (message?.message !== unique || !message.claim_token) {
    throw new Error('Scoped internal relay did not claim the exact queued message');
  }

  const result = await request(`${BASE_URL}/api/imessage/queue/${message.id}/result`, {
    method: 'POST',
    headers: internalRelayHeaders(),
    body: JSON.stringify({ claim_token: message.claim_token, success: true }),
  });
  assertStatus(result.status, 200, result.data);
}

export async function testDeliveryResultThirdFailureIsTerminal(): Promise<void> {
  const uniqueMsg = `Terminal Mac failure ${Date.now()}`;
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'mac-terminal-agent',
      idempotency_key: `mac-terminal-${Date.now()}`,
      phone_number: '+19729777432',
      message: uniqueMsg,
    }),
  });
  assertStatus(queued.status, 200, queued.data);

  for (let failure = 1; failure <= 3; failure += 1) {
    const claim = await request(`${BASE_URL}/api/imessage/queue/pop`, {
      headers: ackAuthHeaders(ctx.accessToken!),
    });
    assertStatus(claim.status, 200, claim.data);
    const message = (
      claim.data as {
        message: { id: string; message: string; claim_token: string } | null;
      }
    ).message;
    if (message?.message !== uniqueMsg) throw new Error(`Missing failure claim ${failure}`);
    const result = await request(`${BASE_URL}/api/imessage/queue/${message.id}/result`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({
        claim_token: message.claim_token,
        success: false,
        error: `send failure ${failure}`,
      }),
    });
    assertStatus(result.status, 200, result.data);
    const body = result.data as { terminal_failure: boolean };
    if (body.terminal_failure !== (failure === 3)) {
      throw new Error(`Unexpected terminal state after failure ${failure}`);
    }
  }

  const afterFailure = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: ackAuthHeaders(ctx.accessToken!),
  });
  if ((afterFailure.data as { message: unknown | null }).message !== null) {
    throw new Error('Terminally failed iMessage remained eligible for another send');
  }

  const receipt = queued.data as { queue_id: string };
  const status = await request(`${BASE_URL}/api/imessage/queue/${receipt.queue_id}/status`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  const body = status.data as { status: string; failures: number; last_error: string };
  if (body.status !== 'failed' || body.failures !== 3 || body.last_error !== 'send failure 3') {
    throw new Error(`Expected terminal failure receipt, got ${JSON.stringify(status.data)}`);
  }
}

export async function testQueuedEntryPersistsUntilMacReturns(): Promise<void> {
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'durable-agent',
      idempotency_key: `durable-${Date.now()}`,
      phone_number: '+19729777432',
      message: 'Send whenever the Mac returns',
    }),
  });
  assertStatus(queued.status, 200, queued.data);
  const receipt = queued.data as { queue_id: string };
  await prisma.imessageQueue.update({
    where: { id: receipt.queue_id },
    data: { createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) },
  });

  const status = await request(`${BASE_URL}/api/imessage/queue/${receipt.queue_id}/status`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(status.status, 200, status.data);
  if ((status.data as { status: string }).status !== 'queued') {
    throw new Error(`Expected durable queued status, got ${JSON.stringify(status.data)}`);
  }

  const pop = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: ackAuthHeaders(ctx.accessToken!),
  });
  const message = (pop.data as { message: { id: string } | null }).message;
  if (message?.id !== receipt.queue_id) {
    throw new Error('A week-old queued iMessage was not available when the Mac returned');
  }
}

export async function testQueueDatabaseDefaultDoesNotExpire(): Promise<void> {
  const row = await prisma.imessageQueue.create({
    data: {
      userId: ctx.userId!,
      agentId: 'durable-default-agent',
      phoneNumber: '+19729777432',
      message: 'Writer omitted expiresAt',
    },
  });
  if (row.expiresAt !== null) {
    throw new Error(`Expected no queue expiry, got ${row.expiresAt.toISOString()}`);
  }

  const cleanup = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(cleanup.status, 200, cleanup.data);
  const message = (cleanup.data as { message: { id: string } | null }).message;
  if (message?.id !== row.id) throw new Error('Non-expiring row was not safely consumable');
}

export async function testQueueReceiptIncludesRelayStatusAtEnqueue(): Promise<void> {
  await prisma.user.updateMany({
    where: { userId: ctx.userId! },
    data: { imessageBridgeLastSeenAt: new Date(Date.now() - 10 * 60 * 1_000) },
  });
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'relay-receipt-agent',
      idempotency_key: `relay-receipt-${Date.now()}`,
      phone_number: '+19729777432',
      message: 'Relay receipt status',
    }),
  });
  assertStatus(queued.status, 200, queued.data);
  const body = queued.data as {
    relay_connected?: boolean;
    relay_last_seen_at?: string | null;
  };
  if (body.relay_connected !== false || typeof body.relay_last_seen_at !== 'string') {
    throw new Error(`Expected stale relay receipt, got ${JSON.stringify(queued.data)}`);
  }
}

export async function testBridgeHeartbeatMakesExactBackendReady(): Promise<void> {
  const heartbeat = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: ackAuthHeaders(ctx.accessToken!),
  });
  assertStatus(heartbeat.status, 200, heartbeat.data);

  const status = await request(`${BASE_URL}/api/imessage/bridge/status`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(status.status, 200, status.data);
  const body = status.data as { connected: boolean; last_seen_at: string | null };
  if (!body.connected || body.last_seen_at === null) {
    throw new Error(`Expected fresh Mac bridge heartbeat, got ${JSON.stringify(status.data)}`);
  }
}
