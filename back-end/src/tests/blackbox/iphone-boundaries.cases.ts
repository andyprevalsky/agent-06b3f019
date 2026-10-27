import { permitted, deadlineElapsed } from '../../domains/iphone/config';
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';

type Reply = { status: number; data: unknown };
interface BoundaryContext {
  test: (name: string, run: () => Promise<void>) => void;
  request: (path: string, userId?: string, method?: string, body?: unknown) => Promise<Reply>;
  user: (phone?: string) => Promise<string>;
  agent: (userId: string) => Promise<{ id: string }>;
  fixture: () => Promise<{ userId: string; providerDeviceId: string }>;
  acquire: (userId: string, agentId: string) => Promise<{ id: string }>;
  action: (userId: string, id: string, operation: string, body?: unknown) => Promise<Reply>;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function registerIPhoneBoundaryTests(context: BoundaryContext): void {
  const { test, request, user, agent, fixture, acquire, action } = context;
  test('Andy is enabled while deferred accounts and anonymous phone fallback stay disabled', async () => {
    assert(
      permitted({ userId: 'c49b4ce3-3489-499d-bfbd-846d04ba6275', phone: null, isAnonymous: true }),
      'Andy account denied'
    );
    assert(
      !permitted({
        userId: '8283e892-b0a4-4298-9ef7-b95bcc67e46b',
        phone: null,
        isAnonymous: false,
      }),
      'Deferred account was enabled'
    );
    assert(!permitted(null), 'missing user allowed');
    assert(deadlineElapsed(new Date(1000), new Date(1000)), 'deadline equality must expire');
    assert(!deadlineElapsed(new Date(1001), new Date(1000)), 'future deadline expired');
    assert(deadlineElapsed(null, new Date(1000)), 'missing deadline must expire');
    assert(
      !permitted({ userId: 'synthetic', phone: '+19729777432', isAnonymous: true }),
      'anonymous fallback allowed'
    );
    assert(
      permitted({ userId: 'synthetic', phone: '+19729777432', isAnonymous: false }),
      'trusted phone fallback denied'
    );
  });

  for (const cause of ['deleted', 'terminal'] as const) {
    test(`${cause} waiters do not inflate queue position behind a live holder`, async () => {
      const f = await fixture();
      const agents = await Promise.all([0, 1, 2].map(() => agent(f.userId)));
      const leases = [];
      for (const current of agents) leases.push(await acquire(f.userId, current.id));
      await prisma.agent.update({
        where: { id: agents[1].id },
        data: cause === 'deleted' ? { deletedAt: new Date() } : { status: 'COMPLETED' },
      });
      const observed = await request(`/leases/${leases[2].id}`, f.userId);
      const state = observed.data as { lease: { queuePosition: number } };
      assert(state.lease.queuePosition === 1, 'Dead waiter inflated queue position');
      const holder = await request(`/leases/${leases[0].id}`, f.userId);
      assert(
        (holder.data as { lease: { status: string } }).lease.status === 'ACTIVE',
        'Queue read released the holder'
      );
    });
  }

  test('every lease endpoint requires authentication before validating inputs', async () => {
    for (const [path, method] of [
      ['/leases', 'POST'],
      [`/leases/${randomUUID()}`, 'GET'],
      ...['heartbeat', 'release', 'control', 'awaiting-auth'].map((operation) => [
        `/leases/${randomUUID()}/${operation}`,
        'POST',
      ]),
    ]) {
      const response = await request(path, undefined, method);
      assert(response.status === 401, `${method} ${path} accepted unauthenticated input`);
    }
  });

  test('client feature and identity fields cannot enable ordinary or anonymous accounts', async () => {
    for (const anonymous of [false, true]) {
      const userId = await user(anonymous ? '+19729777432' : '+15550001111');
      if (anonymous) {
        await prisma.user.update({ where: { userId }, data: { isAnonymous: true } });
      }
      const ownAgent = await agent(userId);
      const response = await request('/leases', userId, 'POST', {
        agentId: ownAgent.id,
        requestKey: randomUUID(),
        enabled: true,
        iphoneEnabled: true,
        isAnonymous: false,
        phone: '+19729777432',
      });
      assert(response.status === 403, 'request fields overrode persisted feature eligibility');
      assert(
        (await prisma.iPhoneLease.count({ where: { userId } })) === 0,
        'disabled account allocated a lease'
      );
    }
  });

  test('heartbeat renews active ownership and public views exclude provider data', async () => {
    const f = await fixture();
    const ownAgent = await agent(f.userId);
    const lease = await acquire(f.userId, ownAgent.id);
    const shortDeadline = new Date(Date.now() + 5000);
    await prisma.iPhoneLease.update({
      where: { id: lease.id },
      data: { leaseExpiresAt: shortDeadline },
    });
    const before = Date.now();
    const response = await action(f.userId, lease.id, 'heartbeat');
    assert(response.status === 200, 'active heartbeat failed');
    const renewed = (response.data as { lease: Record<string, unknown> }).lease;
    const deadline = Date.parse(String(renewed.leaseExpiresAt));
    assert(renewed.status === 'ACTIVE', 'renewal lost ownership');
    assert(deadline > shortDeadline.getTime(), 'heartbeat did not extend the active deadline');
    assert(deadline >= before + 119000 && deadline <= Date.now() + 121000, 'unbounded renewal');
    assert(
      Object.keys(renewed).sort().join(',') ===
        [
          'id',
          'agentId',
          'browserTaskId',
          'status',
          'queuePosition',
          'queueDeadlineAt',
          'leaseExpiresAt',
          'controlOwner',
          'attentionRequestId',
          'revision',
        ]
          .sort()
          .join(','),
      'public lease shape exposed private fields'
    );
    assert(!JSON.stringify(response.data).includes(f.providerDeviceId), 'provider device leaked');
    assert(
      (
        await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: lease.id } })
      ).leaseExpiresAt?.getTime() === deadline,
      'response deadline differs from persisted ownership'
    );
  });
}
