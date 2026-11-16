/**
 * Run 43785616839 (2026-11-16): the cutover controller's drain-loop `assert`
 * exited 1 while ownership held (the parent's lease renewals and its failure
 * mutation passed the same lease, job and FIFO-head checks within 330 ms), so
 * by elimination the assertion died on its database connection. Hold the
 * lease lock so the assertion is parked mid-body, kill its backend, and
 * require the read-only assertion to retry instead of failing.
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
    // Wait (bounded) until exactly the assertion is parked behind the held lease lock.
    const waiters = await retryWithBackoff(
      () =>
        holder.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
      {
        maxRetries: 400,
        fixedDelays: Array(400).fill(25),
        shouldRetryResult: (rows) => rows.length === 0,
        component: 'TransientAssertFixture',
      }
    );
    assert.equal(
      waiters.length,
      1,
      `expected only the assertion behind the lease lock: ${JSON.stringify(waiters)}`
    );
    const [{ terminated }] = await holder.$queryRaw<Array<{ terminated: boolean }>>`
      SELECT pg_terminate_backend(${waiters[0].pid}::int) AS terminated`;
    assert.equal(terminated, true, 'the parked assertion backend was not terminated');
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
