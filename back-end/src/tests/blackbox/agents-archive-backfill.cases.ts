/**
 * Archived-agent status backfill cases (providers/archivedAgentStatusBackfill):
 * settles archived non-terminal rows once, skips benchmark, money-in-flight and
 * breadcrumb-skeleton agents, and is idempotent on the test's own rows.
 *
 * Registered by `agents.blackbox.ts` (`await import('./agents-archive-backfill.cases')`).
 */
import {
  RUN_ID,
  assert,
  createAnonymousSession,
  createAgentRow,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';
import { backfillArchivedAgentStatus } from '../../providers/archivedAgentStatusBackfill';

test('archived-agent status backfill settles only archived non-terminal rows, idempotently', async () => {
  const session = await createAnonymousSession('archive-backfill');
  const staleId = await createAgentRow(session.user.id, `Archive backfill stale ${RUN_ID}`, {
    deletedAt: new Date(),
  });
  const liveId = await createAgentRow(session.user.id, `Archive backfill live ${RUN_ID}`);
  const benchmarkId = await createAgentRow(session.user.id, `Archive backfill bench ${RUN_ID}`, {
    deletedAt: new Date(),
    isBenchmark: true,
  });
  const heldId = await createAgentRow(session.user.id, `Archive backfill held ${RUN_ID}`, {
    deletedAt: new Date(),
  });
  await prisma.purchaseSpend.create({
    data: {
      userId: session.user.id,
      agentId: heldId,
      status: 'HELD',
      fingerprint: `archive-backfill-${randomUUID()}`,
      merchant: 'backfill fixture',
      lineItemsJson: [],
      totalCents: 100,
    },
  });
  const skeletonId = await createAgentRow(
    'benchmark-hub-ancestors',
    `Archive backfill skeleton ${RUN_ID}`,
    { deletedAt: new Date() }
  );

  const dryRun = await backfillArchivedAgentStatus({ execute: false });
  assert(dryRun.pendingBefore >= 1 && dryRun.updated === 0, 'dry run must count but not write');
  const first = await backfillArchivedAgentStatus({ execute: true, batchSize: 1 });
  assert(first.updated >= 1, `backfill must settle the stale row, got ${JSON.stringify(first)}`);
  // Idempotency is asserted on this test's own row: concurrent domains share
  // the database and may archive agents between runs, so a global "nothing
  // left" count races them.
  const settledAt = (
    await prisma.agent.findUniqueOrThrow({ where: { id: staleId }, select: { updatedAt: true } })
  ).updatedAt;
  await backfillArchivedAgentStatus({ execute: true });
  const afterSecond = await prisma.agent.findUniqueOrThrow({
    where: { id: staleId },
    select: { updatedAt: true },
  });
  assert(
    afterSecond.updatedAt.getTime() === settledAt.getTime(),
    'a second run must not touch an already-settled row'
  );

  const rows = await prisma.agent.findMany({
    where: { id: { in: [staleId, liveId, benchmarkId, heldId, skeletonId] } },
    select: { id: true, status: true, statusMessage: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert(
    byId.get(staleId)?.status === 'FAILED' &&
      byId.get(staleId)?.statusMessage === 'Archived by user',
    'the archived ACTIVE row must become FAILED/"Archived by user"'
  );
  assert(byId.get(liveId)?.status === 'ACTIVE', 'a non-archived ACTIVE row must be untouched');
  for (const [agentId, why] of [
    [benchmarkId, 'an isBenchmark agent (benchmark cleanup has its own owner)'],
    [heldId, 'an agent holding a HELD purchase spend (no money may move)'],
    [skeletonId, 'a benchmark-hub ancestor skeleton (breadcrumb mirror)'],
  ] as const) {
    assert(byId.get(agentId)?.status === 'ACTIVE', `the backfill must skip ${why}`);
  }
  await prisma.purchaseSpend.deleteMany({ where: { agentId: heldId } });
});
