#!/usr/bin/env tsx
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import { registerIPhoneBoundaryTests } from './iphone-boundaries.cases';
config();
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';
const KEY = process.env.BACKEND_API_KEY || '';
const users: string[] = [];
const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, run: () => Promise<void>) {
  tests.push([name, run]);
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function request(
  path: string,
  userId?: string,
  method = 'GET',
  body?: unknown,
  apiKey = KEY
) {
  const response = await fetch(`${BASE}/api/iphone${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { 'X-API-Key': apiKey, 'X-User-Id': userId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
async function user(phone?: string) {
  const userId = `iphone-blackbox-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { userId, phone } });
  return userId;
}
test('unauthenticated capability is rejected', async () => {
  const response = await request('/capability');
  assert(response.status === 401, `expected 401, got ${response.status}`);
});
test('ordinary account is disabled and cannot allocate a phone', async () => {
  const id = await user('+15550001111');
  const response = await request('/capability', id);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  assert(response.data.enabled === false, 'ordinary account must be disabled');
  const bind = await request('/device', id, 'PUT', {
    providerDeviceId: `fixture-${randomUUID()}`,
  });
  assert(bind.status === 403, `expected 403, got ${bind.status}`);
});
async function expectStatus(
  response: Promise<{ status: number | string; data?: unknown }>,
  expected: number | string
) {
  const result = await response;
  assert(
    result.status === expected,
    `expected ${expected}, got ${result.status}: ${JSON.stringify(result.data)}`
  );
}
async function expire(id: string, field = 'leaseExpiresAt') {
  await prisma.iPhoneLease.update({ where: { id }, data: { [field]: new Date(0) } });
}
async function agent(userId: string) {
  return prisma.agent.create({
    data: { userId, goal: 'Synthetic iPhone lease blackbox', status: 'ACTIVE' },
  });
}
async function fixture() {
  const userId = await user('+19729777432');
  const providerDeviceId = `fixture-${randomUUID()}`;
  const bound = await request('/device', userId, 'PUT', { providerDeviceId });
  assert([200, 201].includes(bound.status), `bind failed ${bound.status}`);
  const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { userId } });
  return { userId, device, providerDeviceId };
}
async function acquire(
  userId: string,
  agentId: string,
  requestKey = randomUUID(),
  browserTaskId?: string
) {
  const response = await request('/leases', userId, 'POST', { agentId, requestKey, browserTaskId });
  assert(
    [200, 201].includes(response.status),
    `acquire failed ${response.status}: ${JSON.stringify(response.data)}`
  );
  assert(
    response.data.lease && typeof response.data.lease.id === 'string',
    'lease wrapper missing'
  );
  return response.data.lease;
}
async function view(userId: string, id: string) {
  const response = await request(`/leases/${id}`, userId);
  assert(response.status === 200, `read failed ${response.status}`);
  return response.data.lease;
}
async function action(userId: string, id: string, operation: string, body?: unknown) {
  return request(`/leases/${id}/${operation}`, userId, 'POST', body);
}
async function attention(userId: string, agentId: string) {
  return prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId,
      workflowId: `fixture-${randomUUID()}`,
      question: 'Authenticate synthetic phone',
    },
  });
}
test('allowlisted unconfigured capability exposes only public state and cannot acquire', async () => {
  const id = await user('+19729777432');
  const a = await agent(id);
  const capability = await request('/capability', id);
  assert(
    capability.status === 200 && capability.data.configured === false,
    'unconfigured capability'
  );
  assert(
    Object.keys(capability.data).sort().join(',') === 'configured,enabled,setupState',
    'capability exposes private fields'
  );
  const claim = await request('/leases', id, 'POST', {
    agentId: a.id,
    requestKey: 'unconfigured',
  });
  assert(claim.status === 409, `unconfigured acquisition ${claim.status}`);
});
test('binding is idempotent but devices cannot be rebound or transferred', async () => {
  const f = await fixture();
  await expectStatus(
    request('/device', f.userId, 'PUT', { providerDeviceId: f.providerDeviceId }),
    200
  );
  const other = await user('+19729777432');
  await expectStatus(
    request('/device', other, 'PUT', { providerDeviceId: f.providerDeviceId }),
    409
  );
  await expectStatus(
    request('/device', f.userId, 'PUT', { providerDeviceId: `fixture-${randomUUID()}` }),
    409
  );
});
test('concurrent same-key retries preserve exactly one lease and deadlines', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const key = randomUUID();
  const claims = await Promise.all(Array.from({ length: 8 }, () => acquire(f.userId, a.id, key)));
  assert(new Set(claims.map((l) => l.id)).size === 1, 'retry duplicated lease');
  assert(
    claims.every((l) => l.status === 'ACTIVE'),
    'first lease not active'
  );
  assert(new Set(claims.map((l) => l.queueDeadlineAt)).size === 1, 'retry reset queue deadline');
  assert(
    (await prisma.iPhoneLease.count({ where: { deviceId: f.device.id } })) === 1,
    'multiple persisted retries'
  );
});
test('concurrent independent requests admit one holder and FIFO waiters', async () => {
  const f = await fixture();
  const agents = await Promise.all(Array.from({ length: 7 }, () => agent(f.userId)));
  const claims = await Promise.all(agents.map((a) => acquire(f.userId, a.id)));
  assert(claims.filter((l) => l.status === 'ACTIVE').length === 1, 'multiple active holders');
  assert(claims.filter((l) => l.status === 'WAITING').length === 6, 'missing waiting leases');
  assert(
    (await prisma.iPhoneLease.count({ where: { deviceId: f.device.id, status: 'ACTIVE' } })) === 1,
    'persisted holder count differs'
  );
  const ordered = await prisma.iPhoneLease.findMany({
    where: { deviceId: f.device.id },
    orderBy: { ticket: 'asc' },
  });
  for (const lease of ordered) {
    await expectStatus(view(f.userId, lease.id), 'ACTIVE');
    await expectStatus(action(f.userId, lease.id, 'release'), 200);
  }
});
test('FIFO promotion skips cancelled waiter and release is idempotent', async () => {
  const f = await fixture();
  const agents = await Promise.all(Array.from({ length: 4 }, () => agent(f.userId)));
  const leases = [];
  for (const a of agents) leases.push(await acquire(f.userId, a.id, 'shared-per-agent-key'));
  assert(
    leases.map((l) => l.status).join(',') === 'ACTIVE,WAITING,WAITING,WAITING',
    'initial FIFO states'
  );
  assert((await view(f.userId, leases[1].id)).queuePosition === 1, 'first waiting position');
  assert((await view(f.userId, leases[2].id)).queuePosition === 2, 'second waiting position');
  await expectStatus(action(f.userId, leases[2].id, 'heartbeat'), 409);
  await expectStatus(action(f.userId, leases[2].id, 'control', { mode: 'user' }), 409);
  await expectStatus(action(f.userId, leases[2].id, 'release'), 200);
  await expectStatus(action(f.userId, leases[0].id, 'release'), 200);
  await expectStatus(view(f.userId, leases[1].id), 'ACTIVE');
  await action(f.userId, leases[0].id, 'release');
  await expectStatus(action(f.userId, leases[0].id, 'heartbeat'), 409);
  await action(f.userId, leases[1].id, 'release');
  await expectStatus(view(f.userId, leases[3].id), 'ACTIVE');
});
test('cross-account lease read/actions are 404 and forged agent ownership denied', async () => {
  const f = await fixture();
  const other = await fixture();
  const a = await agent(f.userId);
  const lease = await acquire(f.userId, a.id);
  for (const op of ['', '/release', '/control', '/heartbeat', '/awaiting-auth']) {
    const response = await request(
      `/leases/${lease.id}${op}`,
      other.userId,
      op ? 'POST' : 'GET',
      op ? { mode: 'user', attentionRequestId: randomUUID() } : undefined
    );
    assert(response.status === 404, `foreign ${op || 'read'} returned ${response.status}`);
  }
  const forged = await request('/leases', other.userId, 'POST', {
    agentId: a.id,
    requestKey: randomUUID(),
  });
  assert([403, 404].includes(forged.status), 'forged agent accepted');
  await expectStatus(request(`/leases/${randomUUID()}`, f.userId), 404);
});
test('waiting expires at original five-minute deadline, retry cannot resurrect', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  await acquire(f.userId, a.id);
  const key = randomUUID();
  const lease = await acquire(f.userId, b.id, key);
  const before = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: lease.id } });
  assert(
    Math.abs(before.queueDeadlineAt.getTime() - before.createdAt.getTime() - 300000) < 1000,
    'queue budget differs from five minutes'
  );
  await acquire(f.userId, b.id, key);
  await view(f.userId, lease.id);
  const after = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: lease.id } });
  assert(
    after.queueDeadlineAt.getTime() === before.queueDeadlineAt.getTime(),
    'retry/poll extended deadline'
  );
  await expire(lease.id, 'queueDeadlineAt');
  await expectStatus(view(f.userId, lease.id), 'EXPIRED');
  await expectStatus(acquire(f.userId, b.id, key), 'EXPIRED');
});
test('deadline-equal/late heartbeat expires holder and promotes oldest waiter', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const active = await acquire(f.userId, a.id);
  const waiting = await acquire(f.userId, b.id);
  await prisma.iPhoneLease.update({
    where: { id: active.id },
    data: { leaseExpiresAt: new Date() },
  });
  await expectStatus(action(f.userId, active.id, 'heartbeat'), 409);
  await expectStatus(view(f.userId, active.id), 'EXPIRED');
  await expectStatus(view(f.userId, waiting.id), 'ACTIVE');
});
test('pending auth retains paused lease across expiration; resolved auth provides bounded grace', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const active = await acquire(f.userId, a.id);
  const waiting = await acquire(f.userId, b.id);
  const auth = await attention(f.userId, a.id);
  await expectStatus(
    action(f.userId, active.id, 'awaiting-auth', { attentionRequestId: auth.id }),
    200
  );
  await prisma.agent.update({ where: { id: a.id }, data: { status: 'PAUSED' } });
  await expire(active.id);
  const retained = await view(f.userId, active.id);
  assert(
    retained.status === 'ACTIVE' && retained.attentionRequestId === auth.id,
    'pending auth lease lost'
  );
  await expectStatus(view(f.userId, waiting.id), 'WAITING');
  await prisma.agentAttentionRequest.update({
    where: { id: auth.id },
    data: { userResponse: 'done' },
  });
  const resumed = await view(f.userId, active.id);
  assert(
    resumed.status === 'ACTIVE' && resumed.attentionRequestId === null,
    'completed auth lost owner or retained binding'
  );
  const deadline = Date.parse(resumed.leaseExpiresAt);
  assert(
    deadline > Date.now() + 90000 && deadline <= Date.now() + 120000,
    'completed auth lacks bounded fresh grace'
  );
  assert(
    (await view(f.userId, active.id)).leaseExpiresAt === resumed.leaseExpiresAt,
    'polling extended auth grace'
  );
  await expectStatus(view(f.userId, waiting.id), 'WAITING');
  await expectStatus(action(f.userId, active.id, 'heartbeat'), 200);
  await expire(active.id);
  await expectStatus(view(f.userId, active.id), 'EXPIRED');
  await expectStatus(view(f.userId, waiting.id), 'ACTIVE');
});
test('awaiting-auth rejects cross-user, sibling-agent and resolved attention', async () => {
  const f = await fixture();
  const other = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const foreignAgent = await agent(other.userId);
  const lease = await acquire(f.userId, a.id);
  const foreign = await attention(other.userId, foreignAgent.id);
  const sibling = await attention(f.userId, b.id);
  const resolved = await attention(f.userId, a.id);
  await prisma.agentAttentionRequest.update({
    where: { id: resolved.id },
    data: { userResponse: 'done' },
  });
  for (const row of [foreign, sibling, resolved]) {
    const response = await action(f.userId, lease.id, 'awaiting-auth', {
      attentionRequestId: row.id,
    });
    assert(
      [400, 404, 409].includes(response.status),
      `invalid attention accepted ${response.status}`
    );
  }
  assert(
    (await view(f.userId, lease.id)).attentionRequestId === null,
    'invalid attention persisted'
  );
});
test('terminal active and deleted waiting agents relinquish claims even with pending auth', async () => {
  const f = await fixture();
  const agents = await Promise.all(Array.from({ length: 3 }, () => agent(f.userId)));
  const first = await acquire(f.userId, agents[0].id);
  const second = await acquire(f.userId, agents[1].id);
  const third = await acquire(f.userId, agents[2].id);
  const auth = await attention(f.userId, agents[0].id);
  await action(f.userId, first.id, 'awaiting-auth', { attentionRequestId: auth.id });
  await prisma.agent.update({ where: { id: agents[0].id }, data: { status: 'COMPLETED' } });
  await prisma.agent.update({ where: { id: agents[1].id }, data: { deletedAt: new Date() } });
  await expectStatus(view(f.userId, third.id), 'ACTIVE');
  assert((await view(f.userId, first.id)).status !== 'ACTIVE', 'terminal retained auth claim');
  assert((await view(f.userId, second.id)).status !== 'ACTIVE', 'deleted waiter promoted');
});
test('disabled phone denies acquisition/renew/control/auth but permits cleanup/release', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const lease = await acquire(f.userId, a.id);
  await prisma.iPhoneDevice.update({ where: { id: f.device.id }, data: { enabled: false } });
  assert((await request('/capability', f.userId)).data.enabled === false, 'disabled capability');
  await expectStatus(
    request('/leases', f.userId, 'POST', { agentId: a.id, requestKey: randomUUID() }),
    403
  );
  for (const op of ['heartbeat', 'control', 'awaiting-auth']) {
    await expectStatus(
      action(f.userId, lease.id, op, { mode: 'user', attentionRequestId: randomUUID() }),
      403
    );
  }
  await expectStatus(action(f.userId, lease.id, 'release'), 200);
});
test('server identity revocation rechecks lease authorization', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const lease = await acquire(f.userId, a.id);
  await prisma.user.update({ where: { userId: f.userId }, data: { phone: '+15550009999' } });
  await expectStatus(action(f.userId, lease.id, 'heartbeat'), 403);
  await expectStatus(action(f.userId, lease.id, 'release'), 200);
});
test('independent phones proceed concurrently; control has exactly one owner', async () => {
  const fixtures = await Promise.all([fixture(), fixture()]);
  const agents = await Promise.all(fixtures.map((f) => agent(f.userId)));
  const leases = await Promise.all(fixtures.map((f, i) => acquire(f.userId, agents[i].id)));
  assert(
    leases.every((l) => l.status === 'ACTIVE'),
    'independent phone blocked'
  );
  const f = fixtures[0];
  const lease = leases[0];
  assert(lease.controlOwner === 'agent', 'default control');
  const taken = await action(f.userId, lease.id, 'control', { mode: 'user' });
  assert(taken.status === 200 && taken.data.lease.controlOwner === 'user', 'takeover failed');
  const userKey = `rose-phone-control-${randomUUID()}`;
  await prisma.roseApiKey.create({ data: { userId: f.userId, apiKey: userKey } });
  await prisma.subscription.create({
    data: {
      userId: f.userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `fixture-${randomUUID()}`,
      stripeCustomerId: `fixture-${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    },
  });
  const returned = await request(
    `/leases/${lease.id}/control`,
    f.userId,
    'POST',
    { mode: 'agent' },
    userKey
  );
  assert(
    returned.status === 200 && returned.data.lease.controlOwner === 'agent',
    'handback failed'
  );
  await expectStatus(action(f.userId, lease.id, 'control', { mode: 'both' }), 400);
  await expectStatus(action(f.userId, lease.id, 'heartbeat'), 200);
});
test('browser task validates same agent and owning account', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const context = await prisma.browserContext.create({
    data: { userId: f.userId, contextId: `fixture-${randomUUID()}` },
  });
  const session = await prisma.browserSession.create({
    data: { contextId: context.id, agentId: a.id, sessionId: `fixture-${randomUUID()}` },
  });
  assert(
    (await acquire(f.userId, a.id, randomUUID(), session.id)).browserTaskId === session.id,
    'valid browser binding lost'
  );
  const forged = await request('/leases', f.userId, 'POST', {
    agentId: b.id,
    requestKey: randomUUID(),
    browserTaskId: session.id,
  });
  assert([403, 404].includes(forged.status), 'sibling browser binding accepted');
});

test('idempotency key cannot change its browser task association', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const context = await prisma.browserContext.create({
    data: { userId: f.userId, contextId: `fixture-${randomUUID()}` },
  });
  const sessions = await Promise.all(
    [0, 1].map(() =>
      prisma.browserSession.create({
        data: { contextId: context.id, agentId: a.id, sessionId: `fixture-${randomUUID()}` },
      })
    )
  );
  const key = randomUUID();
  const original = await acquire(f.userId, a.id, key, sessions[0].id);
  const changed = await request('/leases', f.userId, 'POST', {
    agentId: a.id,
    requestKey: key,
    browserTaskId: sessions[1].id,
  });
  assert(changed.status === 409, `changed browser association returned ${changed.status}`);
  assert(
    (await view(f.userId, original.id)).browserTaskId === sessions[0].id,
    'original browser association overwritten'
  );
});
test('failed and exhausted agents cannot acquire and their queued leases are skipped', async () => {
  for (const status of ['FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] as const) {
    const f = await fixture();
    const a = await agent(f.userId);
    const b = await agent(f.userId);
    const c = await agent(f.userId);
    const active = await acquire(f.userId, a.id);
    await acquire(f.userId, b.id);
    const third = await acquire(f.userId, c.id);
    await prisma.agent.update({ where: { id: a.id }, data: { status } });
    await prisma.agent.update({ where: { id: b.id }, data: { status } });
    await expectStatus(view(f.userId, third.id), 'ACTIVE');
    assert(
      (await view(f.userId, active.id)).status !== 'ACTIVE',
      `${status} retained active lease`
    );
    const rejected = await request('/leases', f.userId, 'POST', {
      agentId: a.id,
      requestKey: randomUUID(),
    });
    assert([404, 409].includes(rejected.status), `${status} acquired a new lease`);
  }
});

test('user API key cannot bind a provider device or forge server-owned enablement', async () => {
  const id = await user('+19729777432');
  const token = `fixture-key-${randomUUID()}`;
  await prisma.subscription.create({
    data: {
      userId: id,
      subscriptionTier: 1,
      stripeSubscriptionId: `fixture-${randomUUID()}`,
      stripeCustomerId: `fixture-${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 86400000),
    },
  });
  await prisma.roseApiKey.create({ data: { userId: id, apiKey: token } });
  const response = await fetch(`${BASE}/api/iphone/device`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': token },
    body: JSON.stringify({
      providerDeviceId: `fixture-${randomUUID()}`,
      enabled: true,
      isInternal: true,
    }),
  });
  assert(response.status === 403, `self-service provider binding accepted ${response.status}`);
  assert(
    (await prisma.iPhoneDevice.count({ where: { userId: id } })) === 0,
    'forged device allocated'
  );
});

test('explicit release during pending auth promotes waiter without resolving attention', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const first = await acquire(f.userId, a.id);
  const waiting = await acquire(f.userId, b.id);
  const auth = await attention(f.userId, a.id);
  await action(f.userId, first.id, 'awaiting-auth', { attentionRequestId: auth.id });
  await expectStatus(action(f.userId, first.id, 'release'), 200);
  await expectStatus(view(f.userId, waiting.id), 'ACTIVE');
  assert(
    (await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id: auth.id } }))
      .userResponse === null,
    'lease release fabricated attention response'
  );
  await expectStatus(action(f.userId, first.id, 'control', { mode: 'user' }), 409);
});
test('racing release and acquisition preserve queued precedence and one holder', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const c = await agent(f.userId);
  const first = await acquire(f.userId, a.id);
  const queued = await acquire(f.userId, b.id);
  const [, newcomer] = await Promise.all([
    action(f.userId, first.id, 'release'),
    acquire(f.userId, c.id),
  ]);
  await expectStatus(view(f.userId, queued.id), 'ACTIVE');
  await expectStatus(view(f.userId, newcomer.id), 'WAITING');
  assert(
    (await prisma.iPhoneLease.count({ where: { deviceId: f.device.id, status: 'ACTIVE' } })) === 1,
    'race admitted multiple holders'
  );
});

test('rejected auth releases promptly even before heartbeat expiry', async () => {
  const f = await fixture();
  const a = await agent(f.userId);
  const b = await agent(f.userId);
  const active = await acquire(f.userId, a.id);
  const waiting = await acquire(f.userId, b.id);
  const auth = await attention(f.userId, a.id);
  await action(f.userId, active.id, 'awaiting-auth', { attentionRequestId: auth.id });
  await prisma.agentAttentionRequest.update({
    where: { id: auth.id },
    data: { userResponse: '__REJECTED__' },
  });
  await expectStatus(view(f.userId, active.id), 'RELEASED');
  await expectStatus(view(f.userId, waiting.id), 'ACTIVE');
});
test('concurrent identical binds are idempotent; device collision remains denied', async () => {
  const id = await user('+19729777432');
  const providerDeviceId = `fixture-${randomUUID()}`;
  const binds = await Promise.all(
    Array.from({ length: 8 }, () => request('/device', id, 'PUT', { providerDeviceId }))
  );
  assert(
    binds.every((r) => r.status === 200),
    'concurrent identical binding failed'
  );
  const other = await user('+19729777432');
  await expectStatus(request('/device', other, 'PUT', { providerDeviceId }), 409);
});
registerIPhoneBoundaryTests({ test, request, user, agent, fixture, acquire, action });

async function main() {
  let failed = 0;
  try {
    for (const [name, run] of tests) {
      try {
        await run();
        console.log(`✓ ${name}`);
      } catch (error) {
        failed++;
        console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.roseApiKey.deleteMany({ where: { userId: { in: users } } });
    await prisma.agentAttentionRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.agent.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
  }
  console.log(`Passed ${tests.length - failed}/${tests.length} iphone test(s).`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
