import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { prisma } from '../../providers/database';
import { admit, lockedDevice } from '../../domains/iphone/repo';
import { closeLease } from '../../domains/iphone/repo.lifecycle';
import { fixture } from './auth-assistance.native-fixtures';
import { continuityCases } from './iphone-control.continuity.cases';
import { Harness } from './iphone-control.fixtures';

async function concurrentPromotion(h: Harness) {
  const f = await fixture(h);
  const successor = await h.createAgent(f.userId);
  const context = await prisma.browserContext.findUniqueOrThrow({ where: { userId: f.userId } });
  const task = await prisma.browserSession.create({
    data: { agentId: successor.id, contextId: context.id, sessionId: randomUUID() },
  });
  const queued = await h.request(f.userId, `/interactions/${task.id}`, {
    method: 'POST',
    body: { requestKey: randomUUID() },
  });
  assert.equal(queued.data.lease?.status, 'WAITING');
  let observation: ReturnType<Harness['request']> | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      // Stop the reader AFTER its device snapshot, at its first lease lookup.
      await tx.$executeRaw`LOCK TABLE "IPhoneLease" IN ACCESS EXCLUSIVE MODE`;
      const [{ pid, application }] = await tx.$queryRaw<{ pid: number; application: string }[]>`
        SELECT pg_backend_pid() AS pid, current_setting('application_name') AS application`;
      observation = h.request(f.userId, `/availability/${task.id}`);
      const deadline = Date.now() + 5000;
      for (;;) {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
              AND query LIKE '%IPhoneLease%'
              AND application_name = ${application} AND datname = current_database()
          ) AS waiting`;
        if (waiting) break;
        assert.ok(Date.now() < deadline, 'Availability never reached the lease-read barrier');
        await setImmediate();
      }
      const { device } = await lockedDevice(tx, f.userId);
      await closeLease(tx, f.leaseId, 'RELEASED');
      await admit(tx, device.id);
    });
    assert.ok(observation);
    const response = await observation;
    assert.equal(response.status, 200);
    assert.equal(
      response.data.enabled,
      true,
      'Availability cannot mix pre-promotion custody with a post-promotion active lease'
    );
    assert.equal(
      (await h.request(f.userId, `/availability/${task.id}`)).data.enabled,
      true,
      'The committed successor remains available after the concurrent read'
    );
  } finally {
    await observation;
  }
}

async function main() {
  const h = await Harness.start();
  try {
    const sequential = continuityCases.find(([name]) => name.startsWith('FIFO promotion'));
    assert.ok(sequential, 'Registered FIFO regression is missing');
    await sequential[1](h);
    console.log(`PASS ${sequential[0]}`);
    h.resetControls();
    await concurrentPromotion(h);
    assert.equal(h.fixtureErrors.length, 0);
    console.log('PASS concurrent promotion preserves a consistent availability snapshot');
  } finally {
    await h.close();
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
