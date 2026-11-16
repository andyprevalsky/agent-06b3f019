/**
 * Run 43785616839 (2026-11-16): the cutover controller's drain-loop `assert`
 * exited 1 while the parent still renewed the lease every second and the job
 * was FIFO head, so ownership was intact and the assertion died on the
 * database. Hold the lease lock so the assertion is parked mid-body, kill its
 * backend, and require the read-only assertion to retry instead of failing.
 */
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type * as API from '../../providers/workerDeploymentQueue';
import { retryWithBackoff } from '../../providers/retry';

type Ctx = {
  api: typeof API;
  owner: string;
  appFor: (name: string) => string;
  identity: (app: string, attempt: string) => API.WorkerDeploymentIdentity;
  plan: (prefix: string) => Parameters<typeof API.prepareWorkerDeployment>[1];
};
export async function transientAssertionCase({ api, owner, appFor, identity, plan }: Ctx) {
  const app = appFor('transient-assert');
  const job = await api.enqueueWorkerDeployment(identity(app, 'transient-assert'));
  await api.prepareWorkerDeployment(job.jobId, plan('transient-assert'), owner);
  const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
  let lockHeld!: (pid: number) => void;
  const holderPid = new Promise<number>((resolve) => (lockHeld = resolve));
  const holding = holder.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deployment:temporal-workflow-cutover'))`;
      lockHeld((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
      await lockReleased;
    },
    { maxWait: 5000, timeout: 60000 }
  );
  try {
    const pid = await holderPid;
    const settled = api.assertWorkerDeploymentOwned(job.jobId, owner).then(
      () => null,
      (error: unknown) => error
    );
    // Wait (bounded) until the assertion is parked inside its transaction on the lease lock.
    const victim = await retryWithBackoff(
      async () =>
        (
          await holder.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> ${pid} AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock%'`
        )[0]?.pid,
      {
        maxRetries: 400,
        fixedDelays: Array(400).fill(25),
        shouldRetryResult: (found) => found === undefined,
        component: 'TransientAssertFixture',
      }
    );
    assert.ok(victim, 'assertion never parked on the lease lock');
    await holder.$queryRaw`SELECT pg_terminate_backend(${victim}::int)`;
    releaseLock();
    await holding;
    const error = await settled;
    assert.equal(error, null, `ownership assertion failed on a lost connection: ${String(error)}`);
    assert.equal((await api.assertWorkerDeploymentOwned(job.jobId, owner)).jobId, job.jobId);
  } finally {
    releaseLock();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}
