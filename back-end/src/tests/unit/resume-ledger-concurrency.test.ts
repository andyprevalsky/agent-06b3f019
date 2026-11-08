#!/usr/bin/env tsx
/**
 * Deterministic interleavings of the resume spend ledger (resumeReportedSpend.ts)
 * with real parallel transactions on the local database, sequenced by barriers
 * (advisory locks and transactions the test holds open), each step verified in
 * pg_locks before the next one starts. No sleeps decide the order.
 *
 *   a raise arriving while a tree-cost write holds its Agent row is never lost: the
 *     raise is seen WAITING on the row lock, then the write commits, then the raise
 *     increments on top of the written value
 *   the production restore read (resumeFreeTrees) whose statement returns only after
 *     a raise commits is exact (10); a two-statement read (tree, then the ledger in a
 *     later statement) straddling that commit would read 10 - 25 = -15
 */
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  addResumeSpendLocked,
  applyResumeTotal,
  resumeFreeTrees,
} from '../../providers/resumeReportedSpend';
import { applyResumeCost } from '../../domains/agents/agentResumeCostService';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('resume ledger concurrency unit tests');

// This run's own advisory key (parallel copies of this file never share one).
const BARRIER = 1 + Math.floor(Math.random() * 2_000_000_000);

/** A promise plus its resolver: a step the test releases explicitly. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Observe pg_locks (no fixed sleep decides the order) until `ready()` or `stop()` holds. */
async function until(
  ready: () => Promise<boolean>,
  stop: () => boolean = () => false,
  observations = 400
): Promise<void> {
  if ((await ready()) || stop()) return;
  if (observations <= 0) throw new Error('barrier never reached');
  await new Promise((done) => setTimeout(done, 25));
  return until(ready, stop, observations - 1);
}

/** The write's backend parks on THIS run's barrier. */
const waitingOnBarrier = async (writePid: number) =>
  (
    await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${BARRIER} AND pid = ${writePid} AND NOT granted
    `
  )[0].n > 0;

/** Some backend is blocked by the write's backend (the raise on the write's Agent row lock). */
const blockedByWrite = async (writePid: number) =>
  (
    await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE ${writePid}::int = ANY(pg_blocking_pids(pid))
    `
  )[0].n > 0;

async function withAgent(fn: (agentId: string, key: string) => Promise<void>): Promise<void> {
  const agentId = randomUUID();
  const key = `resume:code-resume:${agentId}:m`;
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: `resume-ledger-concurrency-${agentId}`,
      goal: 'resume ledger concurrency',
      status: 'ACTIVE',
      busId: agentId,
      treeCostCents: 0,
    },
  });
  try {
    await fn(agentId, key);
  } finally {
    await prisma.$executeRaw`
      DELETE FROM "SharedEphemeralState"
      WHERE (namespace = ${`resume-reported:${agentId}`} AND key = ${key})
         OR (namespace = 'resume-total' AND key = ${agentId})
    `;
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function tree(agentId: string): Promise<number> {
  return (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).treeCostCents;
}

async function main(): Promise<void> {
  await test('a raise arriving during a tree-cost write waits on the row lock and is never lost', async () => {
    await withAgent(async (agentId, key) => {
      const release = gate();
      const held = gate();
      // The barrier: an advisory lock held by its own transaction until released.
      const holder = prisma.$transaction(
        async (htx) => {
          await htx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${BARRIER})`);
          held.open();
          await release.opened;
        },
        { timeout: 20_000 }
      );
      await held.opened;
      let raiseDone = false;
      const writePid = gate();
      let writeBackend = 0;
      const write = prisma.$transaction(
        async (tx) => {
          const value = await addResumeSpendLocked(tx, agentId, 10); // row locked; ledger 0
          writeBackend = (
            await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          )[0].pid;
          writePid.open();
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${BARRIER})`); // parks
          await tx.agent.update({ where: { id: agentId }, data: { treeCostCents: value } });
        },
        { timeout: 20_000 }
      );
      await writePid.opened;
      await until(() => waitingOnBarrier(writeBackend)); // the write holds the row and is parked
      const raise = applyResumeCost(agentId, { key, total_cents: 25 }).then((result) => {
        raiseDone = true;
        return result;
      });
      // The raise must be parked on the write's row lock (with the lock removed it
      // would finish here instead, and the write's SET would then erase it).
      await until(
        () => blockedByWrite(writeBackend),
        () => raiseDone
      );
      release.open();
      await Promise.all([holder, write, raise]);
      assert.strictEqual(await tree(agentId), 35, 'own 10 + resume 25');
    });
  });

  await test("a restore's resume-free view straddling a raise's commit is exact", async () => {
    await withAgent(async (agentId, key) => {
      await prisma.agent.update({ where: { id: agentId }, data: { treeCostCents: 10 } });
      const commit = gate();
      const raised = gate();
      const raise = prisma.$transaction(
        async (tx) => {
          await applyResumeTotal(tx, [agentId], key, 25);
          raised.open();
          await commit.opened; // the raise stays mid-transaction until released
        },
        { timeout: 20_000 }
      );
      await raised.opened;
      // The PRODUCTION restore read, through a db whose FIRST statement returns only
      // after the raise has committed: a second statement would see the raise its
      // first one missed (a two-statement version reads 10 - 25 = -15 here).
      let statements = 0;
      const straddling = {
        async $queryRaw(...args: unknown[]) {
          const rows = await (prisma.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
          statements += 1;
          if (statements === 1) {
            commit.open();
            await raise;
          }
          return rows;
        },
      } as unknown as Parameters<typeof resumeFreeTrees>[1];
      const view = (await resumeFreeTrees([{ id: agentId }], straddling)).get(agentId);
      assert.strictEqual(view, 10, 'the restore view across the commit is exact');
      assert.strictEqual(statements, 1, 'one statement');
      assert.strictEqual(await tree(agentId), 35);
    });
  });

  finish();
}

void main();
