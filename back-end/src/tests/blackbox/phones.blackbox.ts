#!/usr/bin/env tsx
/**
 * Black-box tests for /api/phones (iPhone attached to the user's Mac via
 * iPhone Mirroring): Mac presence, exclusive control, and the screen relay.
 *
 * Domain surface:
 *   GET  /api/phones                       list (PhoneState[])
 *   GET  /api/phones/:id                   one phone
 *   POST /api/phones/register              Mac presence upsert (JWT, not impersonated)
 *   POST /api/phones/:id/take-control      user takes / renews control
 *   POST /api/phones/:id/release           user hands control back
 *   POST /api/phones/:id/agent/acquire     agent lease (internal key)
 *   POST /api/phones/:id/agent/heartbeat   agent keeps its lease (internal key)
 *   POST /api/phones/:id/agent/release     agent is done (internal key)
 *   GET  /api/phones/:id/stream-demand     Mac long-poll for viewer demand
 *   PUT  /api/phones/:id/frame/upload      Mac uploads one JPEG frame
 *   GET  /api/phones/:id/frame?after=seq   viewer pulls the newest frame
 *
 * Invariants covered:
 *   - auth: no credentials → 401; agent routes need the internal key (403);
 *     impersonated sessions cannot register a phone or upload frames (403)
 *   - owner scoping: another user cannot see, control, stream or let their
 *     agent acquire someone else's phone (404 / AGENT_NOT_FOUND)
 *   - holder state machine: agent holds → user take-control → the agent's
 *     heartbeat/acquire fail fast with PHONE_CONTROL_TAKEN and the exact
 *     tool message → user release → the agent reacquires under a new lease;
 *     a stale lease id is PHONE_LEASE_LOST
 *   - idempotency: register, acquire (same leaseId), take-control, release
 *     and agent release are safe to repeat
 *   - liveness: a lapsed agent or user lease frees the phone; an offline or
 *     stale Mac cannot be acquired (PHONE_OFFLINE)
 *   - relay: on-demand (viewer poll wakes the Mac long-poll), exact bytes,
 *     `after` cursor, content-type and size bounds
 *
 * Usage: bash scripts/run-blackbox-tests.sh phones
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { generateSupabaseSession } from '../../providers/sessionTokens';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const CONTROL_TAKEN_MESSAGE =
  'The user took control of this phone. Stop using it now. You can acquire it again after they hand it back.';

interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
  bytes: Buffer;
}

interface PhoneState {
  id: string;
  name: string;
  model: string | null;
  kind: string;
  macDeviceId: string;
  online: boolean;
  lastSeenAt: string;
  holder: { kind: 'agent' | 'user' | null; agentId?: string; agentTitle?: string | null };
  resumeAgent: { agentId: string; agentTitle: string | null } | null;
  frame: { seq: number } | null;
}

interface Lease {
  phoneId: string;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalMs: number;
}

type Auth = { jwt: string } | { internalUserId: string } | null;

async function call(
  path: string,
  init: { method?: string; auth: Auth; body?: unknown; raw?: Buffer; contentType?: string } = {
    auth: null,
  }
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.raw !== undefined) headers['Content-Type'] = init.contentType ?? 'image/jpeg';
  else if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.auth && 'jwt' in init.auth) headers.Authorization = `Bearer ${init.auth.jwt}`;
  if (init.auth && 'internalUserId' in init.auth) {
    headers['X-API-Key'] = API_KEY;
    headers['X-User-Id'] = init.auth.internalUserId;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let data: Record<string, unknown> = {};
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    data = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  }
  return { status: response.status, data, headers: response.headers, bytes };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

function expectCode(res: Res, status: number, code: string, label: string): void {
  expectStatus(res, status, label);
  assert(res.data.code === code, `${label}: expected code ${code}, got ${String(res.data.code)}`);
}

interface Fixture {
  userId: string;
  jwt: string;
  internal: { internalUserId: string };
  agentIds: string[];
}

const fixtures: Fixture[] = [];

async function createFixture(agentGoals: string[] = []): Promise<Fixture> {
  const userId = `phones-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const agentIds: string[] = [];
  for (const goal of agentGoals) {
    const id = randomUUID();
    await prisma.agent.create({ data: { id, userId, goal, title: goal } });
    agentIds.push(id);
  }
  const fixture = {
    userId,
    jwt: generateSupabaseSession(userId, '').access_token,
    internal: { internalUserId: userId },
    agentIds,
  };
  fixtures.push(fixture);
  return fixture;
}

async function register(
  fx: Fixture,
  overrides: Partial<{ macDeviceId: string; online: boolean; name: string }> = {}
): Promise<PhoneState> {
  const res = await call('/api/phones/register', {
    method: 'POST',
    auth: { jwt: fx.jwt },
    body: {
      macDeviceId: overrides.macDeviceId ?? `mac-${fx.userId}`,
      name: overrides.name ?? "Andy's iPhone",
      model: 'iPhone 16 Pro',
      kind: 'iphone_mirroring',
      online: overrides.online ?? true,
    },
  });
  expectStatus(res, 200, 'register');
  return (res.data as { phone: PhoneState }).phone;
}

async function getPhone(fx: Fixture, id: string): Promise<PhoneState> {
  const res = await call(`/api/phones/${id}`, { auth: { jwt: fx.jwt } });
  expectStatus(res, 200, 'GET phone');
  return res.data as unknown as PhoneState;
}

function agentOp(fx: Fixture, phoneId: string, op: string, agentId: string, leaseId?: string) {
  return call(`/api/phones/${phoneId}/agent/${op}`, {
    method: 'POST',
    auth: fx.internal,
    body: { agent_id: agentId, ...(leaseId === undefined ? {} : { lease_id: leaseId }) },
  });
}

function userOp(fx: Fixture, phoneId: string, op: 'take-control' | 'release') {
  return call(`/api/phones/${phoneId}/${op}`, { method: 'POST', auth: { jwt: fx.jwt } });
}

async function expireLease(phoneId: string): Promise<void> {
  await prisma.phoneDevice.update({
    where: { id: phoneId },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
}

const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x01]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07]);

const tests: { name: string; fn: () => Promise<void> }[] = [
  {
    name: 'auth boundary: anonymous 401, agent routes need the internal key, impersonation 403',
    fn: async () => {
      expectStatus(await call('/api/phones', { auth: null }), 401, 'no auth list');
      const fx = await createFixture(['Auth boundary agent']);
      const phone = await register(fx);
      const asUser = await call(`/api/phones/${phone.id}/agent/acquire`, {
        method: 'POST',
        auth: { jwt: fx.jwt },
        body: { agent_id: fx.agentIds[0] },
      });
      expectStatus(asUser, 403, 'agent acquire with a user JWT');

      const impersonated = generateSupabaseSession(fx.userId, '', {
        actorUserId: `operator-${RUN_ID}`,
      }).access_token;
      const reg = await call('/api/phones/register', {
        method: 'POST',
        auth: { jwt: impersonated },
        body: { macDeviceId: `mac-operator-${RUN_ID}`, name: 'Operator iPhone', online: true },
      });
      expectStatus(reg, 403, 'impersonated register');
      const upload = await call(`/api/phones/${phone.id}/frame/upload`, {
        method: 'PUT',
        auth: { jwt: impersonated },
        raw: JPEG_A,
      });
      expectStatus(upload, 403, 'impersonated frame upload');
      const list = await call('/api/phones', { auth: { jwt: fx.jwt } });
      assert(
        (list.data.phones as PhoneState[]).length === 1,
        'impersonated register created no phone'
      );

      const invalid = await call('/api/phones/register', {
        method: 'POST',
        auth: { jwt: fx.jwt },
        body: { macDeviceId: 'x', name: '', online: 'yes' },
      });
      expectStatus(invalid, 400, 'invalid register body');
      expectCode(
        await call('/api/phones/not-a-uuid', { auth: { jwt: fx.jwt } }),
        404,
        'PHONE_NOT_FOUND',
        'non-uuid phone id'
      );
    },
  },
  {
    name: 'register is an idempotent presence upsert per (user, Mac)',
    fn: async () => {
      const fx = await createFixture();
      const first = await register(fx);
      assert(first.online === true, 'registered phone is online');
      assert(first.kind === 'iphone_mirroring', 'kind');
      assert(first.holder.kind === null && first.resumeAgent === null, 'starts free');
      const again = await register(fx, { name: "Andy's iPhone 16" });
      assert(again.id === first.id, 'same Mac upserts the same phone row');
      assert(again.name === "Andy's iPhone 16", 'name refreshed');
      const offline = await register(fx, { online: false });
      assert(offline.id === first.id && offline.online === false, 'Mac reports disconnected');
      const second = await register(fx, { macDeviceId: `mac-2-${fx.userId}` });
      assert(second.id !== first.id, 'a second Mac is a second phone');
      const list = await call('/api/phones', { auth: { jwt: fx.jwt } });
      expectStatus(list, 200, 'list');
      assert((list.data.phones as PhoneState[]).length === 2, 'two phones listed');
    },
  },
  {
    name: 'owner scoping: another user and their agents cannot reach the phone',
    fn: async () => {
      const owner = await createFixture(['Owner agent']);
      const other = await createFixture(['Other agent']);
      const phone = await register(owner);

      const list = await call('/api/phones', { auth: { jwt: other.jwt } });
      assert((list.data.phones as PhoneState[]).length === 0, 'other user lists nothing');
      expectCode(
        await call(`/api/phones/${phone.id}`, { auth: { jwt: other.jwt } }),
        404,
        'PHONE_NOT_FOUND',
        'other GET'
      );
      expectCode(await userOp(other, phone.id, 'take-control'), 404, 'PHONE_NOT_FOUND', 'take');
      expectCode(await userOp(other, phone.id, 'release'), 404, 'PHONE_NOT_FOUND', 'release');
      expectCode(
        await agentOp(other, phone.id, 'acquire', other.agentIds[0]),
        404,
        'PHONE_NOT_FOUND',
        "other user's agent on owner's phone"
      );
      expectCode(
        await agentOp(owner, phone.id, 'acquire', other.agentIds[0]),
        404,
        'AGENT_NOT_FOUND',
        "foreign agent under the owner's user id"
      );
      expectCode(
        await call(`/api/phones/${phone.id}/frame`, { auth: { jwt: other.jwt } }),
        404,
        'PHONE_NOT_FOUND',
        'other frame GET'
      );
      expectCode(
        await call(`/api/phones/${phone.id}/frame/upload`, {
          method: 'PUT',
          auth: { jwt: other.jwt },
          raw: JPEG_A,
        }),
        404,
        'PHONE_NOT_FOUND',
        'other frame upload'
      );
      assert((await getPhone(owner, phone.id)).holder.kind === null, 'still free');
    },
  },
  {
    name: 'holder state machine: agent → user take-control → exact tool error → release → reacquire',
    fn: async () => {
      const fx = await createFixture(['Book dinner on OpenTable', 'Check the weather']);
      const [agentA, agentB] = fx.agentIds;
      const phone = await register(fx);

      const acquire = await agentOp(fx, phone.id, 'acquire', agentA);
      expectStatus(acquire, 200, 'agent A acquire');
      const lease = acquire.data as unknown as Lease;
      assert(lease.phoneId === phone.id && lease.leaseId.length > 0, 'lease receipt');
      assert(lease.heartbeatIntervalMs > 0, 'heartbeat cadence advertised');
      const held = await getPhone(fx, phone.id);
      assert(held.holder.kind === 'agent' && held.holder.agentId === agentA, 'A holds');
      assert(held.holder.agentTitle === 'Book dinner on OpenTable', 'holder title for the UI');

      const retried = await agentOp(fx, phone.id, 'acquire', agentA);
      expectStatus(retried, 200, 'agent A acquire retry');
      assert((retried.data as unknown as Lease).leaseId === lease.leaseId, 'retry keeps lease');
      expectCode(
        await agentOp(fx, phone.id, 'acquire', agentB),
        409,
        'PHONE_IN_USE_BY_AGENT',
        'agent B blocked'
      );

      const taken = await userOp(fx, phone.id, 'take-control');
      expectStatus(taken, 200, 'take-control');
      const takenState = taken.data as unknown as PhoneState;
      assert(takenState.holder.kind === 'user', 'user holds');
      assert(takenState.resumeAgent?.agentId === agentA, 'A recorded as the agent to resume');
      assert(
        takenState.resumeAgent?.agentTitle === 'Book dinner on OpenTable',
        'release-back line title'
      );
      const takenAgain = await userOp(fx, phone.id, 'take-control');
      expectStatus(takenAgain, 200, 'take-control repeat');
      const againState = takenAgain.data as unknown as PhoneState;
      assert(
        againState.holder.kind === 'user' && againState.resumeAgent?.agentId === agentA,
        'repeat is a renewal'
      );

      const heartbeat = await agentOp(fx, phone.id, 'heartbeat', agentA, lease.leaseId);
      expectCode(heartbeat, 409, 'PHONE_CONTROL_TAKEN', 'A heartbeat after take-control');
      assert(heartbeat.data.error === CONTROL_TAKEN_MESSAGE, 'exact tool-visible message');
      expectCode(
        await agentOp(fx, phone.id, 'acquire', agentA),
        409,
        'PHONE_CONTROL_TAKEN',
        'A cannot reacquire while the user holds'
      );
      expectCode(
        await agentOp(fx, phone.id, 'acquire', agentB),
        409,
        'PHONE_IN_USE_BY_USER',
        'B sees the user holding'
      );

      const released = await userOp(fx, phone.id, 'release');
      expectStatus(released, 200, 'release');
      const releasedState = released.data as unknown as PhoneState;
      assert(releasedState.holder.kind === null, 'free after release');
      assert(releasedState.resumeAgent?.agentId === agentA, 'A may resume');
      const releasedAgain = await userOp(fx, phone.id, 'release');
      expectStatus(releasedAgain, 200, 'release repeat is a no-op');

      const reacquire = await agentOp(fx, phone.id, 'acquire', agentA);
      expectStatus(reacquire, 200, 'A reacquires');
      const lease2 = reacquire.data as unknown as Lease;
      assert(lease2.leaseId !== lease.leaseId, 'a new lease after preemption');
      const resumed = await getPhone(fx, phone.id);
      assert(resumed.holder.agentId === agentA && resumed.resumeAgent === null, 'A resumed');
      expectCode(
        await agentOp(fx, phone.id, 'heartbeat', agentA, lease.leaseId),
        409,
        'PHONE_LEASE_LOST',
        'stale lease id'
      );
      expectStatus(
        await agentOp(fx, phone.id, 'heartbeat', agentA, lease2.leaseId),
        200,
        'current lease heartbeat'
      );

      const agentRelease = await agentOp(fx, phone.id, 'release', agentA, lease2.leaseId);
      expectStatus(agentRelease, 200, 'agent release');
      assert(agentRelease.data.released === true, 'released');
      const agentReleaseAgain = await agentOp(fx, phone.id, 'release', agentA, lease2.leaseId);
      expectStatus(agentReleaseAgain, 200, 'agent release repeat');
      assert(agentReleaseAgain.data.released === false, 'repeat release is a no-op');
      assert((await getPhone(fx, phone.id)).holder.kind === null, 'free');
      expectCode(
        await agentOp(fx, phone.id, 'heartbeat', agentA),
        409,
        'PHONE_LEASE_LOST',
        'heartbeat after release'
      );
    },
  },
  {
    name: 'a lapsed lease frees the phone (dead agent or closed UI never strands it)',
    fn: async () => {
      const fx = await createFixture(['Crashed agent', 'Next agent']);
      const [dead, next] = fx.agentIds;
      const phone = await register(fx);
      expectStatus(await agentOp(fx, phone.id, 'acquire', dead), 200, 'dead agent acquires');
      await expireLease(phone.id);
      assert((await getPhone(fx, phone.id)).holder.kind === null, 'lapsed agent lease is free');
      expectStatus(await agentOp(fx, phone.id, 'acquire', next), 200, 'next agent acquires');
      expectCode(
        await agentOp(fx, phone.id, 'heartbeat', dead),
        409,
        'PHONE_IN_USE_BY_AGENT',
        'the dead holder learns another agent holds it'
      );

      expectStatus(await userOp(fx, phone.id, 'take-control'), 200, 'user takes from next');
      await expireLease(phone.id);
      const afterUser = await getPhone(fx, phone.id);
      assert(afterUser.holder.kind === null, 'lapsed user lease is free');
      assert(afterUser.resumeAgent?.agentId === next, 'preempted agent still may resume');
      expectStatus(await agentOp(fx, phone.id, 'acquire', next), 200, 'next resumes');
    },
  },
  {
    name: 'an offline or stale Mac cannot be acquired',
    fn: async () => {
      const fx = await createFixture(['Offline agent']);
      const phone = await register(fx, { online: false });
      const offline = await agentOp(fx, phone.id, 'acquire', fx.agentIds[0]);
      expectCode(offline, 409, 'PHONE_OFFLINE', 'disconnected mirroring');
      assert(String(offline.data.error).includes('iPhone Mirroring'), 'actionable message');
      await register(fx, { online: true });
      await prisma.phoneDevice.update({
        where: { id: phone.id },
        data: { lastSeenAt: new Date(Date.now() - 5 * 60_000) },
      });
      assert((await getPhone(fx, phone.id)).online === false, 'stale heartbeat reads offline');
      expectCode(
        await agentOp(fx, phone.id, 'acquire', fx.agentIds[0]),
        409,
        'PHONE_OFFLINE',
        'stale Mac'
      );
      await register(fx, { online: true });
      expectStatus(await agentOp(fx, phone.id, 'acquire', fx.agentIds[0]), 200, 'back online');
    },
  },
  {
    name: 'screen relay is on demand: viewer wakes the Mac, exact bytes, after-cursor, bounds',
    fn: async () => {
      const fx = await createFixture();
      const phone = await register(fx);
      const mac = { jwt: fx.jwt };

      const idle = await call(`/api/phones/${phone.id}/stream-demand`, { auth: mac });
      expectStatus(idle, 200, 'demand idle');
      assert(idle.data.requested === false, 'no viewer, no streaming');
      assert(Number(idle.data.maxFps) > 0 && Number(idle.data.maxWidth) > 0, 'bounds advertised');

      const started = Date.now();
      const longPoll = call(`/api/phones/${phone.id}/stream-demand?waitMs=10000`, { auth: mac });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const empty = await call(`/api/phones/${phone.id}/frame`, { auth: { jwt: fx.jwt } });
      expectStatus(empty, 204, 'no frame yet');
      const woke = await longPoll;
      expectStatus(woke, 200, 'long-poll');
      assert(woke.data.requested === true, 'viewer requested a stream');
      assert(Date.now() - started < 5_000, 'long-poll resolved on demand, not on timeout');

      const upload = await call(`/api/phones/${phone.id}/frame/upload`, {
        method: 'PUT',
        auth: mac,
        raw: JPEG_A,
      });
      expectStatus(upload, 200, 'frame upload');
      const seq = Number(upload.data.seq);
      assert(seq > 0, 'frame seq');
      assert((upload.data.stream as { requested: boolean }).requested === true, 'keep streaming');

      const frame = await call(`/api/phones/${phone.id}/frame`, { auth: { jwt: fx.jwt } });
      expectStatus(frame, 200, 'frame GET');
      assert(frame.bytes.equals(JPEG_A), 'exact frame bytes');
      assert(frame.headers.get('content-type') === 'image/jpeg', 'content type');
      assert(frame.headers.get('x-phone-frame-seq') === String(seq), 'seq header');
      assert(frame.headers.get('cache-control') === 'no-store', 'never cached');
      expectStatus(
        await call(`/api/phones/${phone.id}/frame?after=${seq}`, { auth: { jwt: fx.jwt } }),
        204,
        'no newer frame'
      );
      const next = await call(`/api/phones/${phone.id}/frame/upload`, {
        method: 'PUT',
        auth: mac,
        raw: JPEG_B,
      });
      const newer = await call(`/api/phones/${phone.id}/frame?after=${seq}`, {
        auth: { jwt: fx.jwt },
      });
      expectStatus(newer, 200, 'newer frame');
      assert(newer.bytes.equals(JPEG_B), 'newer bytes');
      assert(Number(next.data.seq) > seq, 'seq increases');
      assert((await getPhone(fx, phone.id)).frame?.seq === Number(next.data.seq), 'state frame');

      expectStatus(
        await call(`/api/phones/${phone.id}/frame/upload`, {
          method: 'PUT',
          auth: mac,
          raw: Buffer.from('not an image'),
          contentType: 'text/plain',
        }),
        400,
        'wrong content type'
      );
      expectStatus(
        await call(`/api/phones/${phone.id}/frame/upload`, {
          method: 'PUT',
          auth: mac,
          raw: Buffer.alloc(600 * 1024, 1),
        }),
        413,
        'oversized frame'
      );
    },
  },
];

async function cleanup(): Promise<void> {
  const userIds = fixtures.map((f) => f.userId);
  if (userIds.length === 0) return;
  await prisma.phoneDevice.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
}

async function main(): Promise<void> {
  let failed = 0;
  try {
    for (const test of tests) {
      const start = Date.now();
      try {
        await test.fn();
        console.log(`  PASS  ${test.name} (${Date.now() - start}ms)`);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${test.name} -- ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
