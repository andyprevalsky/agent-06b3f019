import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { anonymousSession, assert, call, expectStatus, type Session } from './projects-harness';
import { prisma } from '../../providers/database';
import {
  claimRun,
  findNightlyDue,
  findGithubPollDue,
  markWatchChecked,
  finishRun,
  publishSnapshot,
} from '../../providers/projects/maintenanceStore';

async function api(session: Session, path: string, init: { method?: string; body?: unknown } = {}) {
  return call(path, { auth: session.token, ...init });
}

export function registerMaintenanceSchedulingCases(userIds: string[]): void {
  test('nightly skips legacy blank batches and watch polling preserves edit order', async () => {
    const owner = await anonymousSession();
    userIds.push(owner.userId);
    const prefix = randomUUID();
    const old = new Date('2000-01-01T00:00:00Z');
    await prisma.project.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        id: `${prefix}-blank-${i}`,
        syncSalt: randomUUID(),
        userId: owner.userId,
        name: `blank-${i}`,
        repoUrl: 'https://github.com/fixture/repo',
        maintenanceNightly: true,
        maintenanceOnGithubChange: true,
        maintenanceScript: i % 2 ? ' \t\r\n' : '\u00a0\ufeff',
        updatedAt: old,
      })),
    });
    const valid = await prisma.project.create({
      data: {
        syncSalt: randomUUID(),
        userId: owner.userId,
        id: randomUUID(),
        name: 'valid-nightly',
        repoUrl: 'https://github.com/fixture/repo',
        maintenanceNightly: true,
        maintenanceOnGithubChange: true,
        maintenanceScript: '  echo hi\n',
        updatedAt: new Date(old.getTime() + 1000),
      },
    });
    const now = new Date();
    // Dedicated connection-local tables make the batch/cutoff proof independent
    // of unrelated projects. Only this serial test's raw-query seam is rebound.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "Project" (LIKE public."Project" INCLUDING DEFAULTS) ON COMMIT DROP'
      );
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "ProjectMaintenanceRun" (LIKE public."ProjectMaintenanceRun" INCLUDING DEFAULTS) ON COMMIT DROP'
      );
      await tx.$executeRaw`INSERT INTO pg_temp."Project" SELECT * FROM public."Project" WHERE "userId" = ${owner.userId}`;
      const original = prisma.$queryRaw;
      const originalFindMany = prisma.project.findMany;
      // Old runtime uses Prisma findMany over these same owner-scoped persisted
      // rows; new runtime uses the copied connection-local rows. Neither sees
      // unrelated projects, so the before/after batch population is identical.
      prisma.project.findMany = ((args: Parameters<typeof originalFindMany>[0]) =>
        originalFindMany.call(prisma.project, {
          ...args,
          where: { ...args?.where, userId: owner.userId },
        })) as typeof originalFindMany;
      prisma.$queryRaw = tx.$queryRaw.bind(tx);
      try {
        const due = await findNightlyDue(now);
        assert(due.includes(valid.id), '50 legacy whitespace rows cannot starve valid script');
        assert(
          !due.some((id) => id.startsWith(prefix)),
          'legacy blank scripts excluded before limit'
        );
        const watched = await findGithubPollDue(now, 60_000);
        assert(
          watched.some((row) => row.id === valid.id),
          'legacy blanks cannot starve GitHub polling'
        );
        assert(
          !watched.some((row) => row.id.startsWith(prefix)),
          'blank watchers excluded before limit'
        );
        const first = await markWatchChecked(valid.id, now);
        const second = await markWatchChecked(valid.id, now);
        assert(first !== null && second !== null, 'watch poll tokens exist');
        assert(
          !(await findGithubPollDue(now, 60_000)).some((row) => row.id === valid.id),
          'recent watch poll remains excluded'
        );
        assert(
          (await findGithubPollDue(new Date(now.getTime() + 60_002), 60_000)).some(
            (row) => row.id === valid.id
          ),
          'watch becomes eligible after original interval'
        );
      } finally {
        prisma.$queryRaw = original;
        prisma.project.findMany = originalFindMany;
      }
    });
    const update = await api(owner, `/api/projects/${valid.id}`, {
      method: 'PUT',
      body: { maintenance: { script: ' \t\n\u00a0' } },
    });
    expectStatus(update, 200, 'blank script update');
    assert(
      (await prisma.project.findUniqueOrThrow({ where: { id: valid.id } })).maintenanceScript ===
        '',
      'new whitespace-only scripts normalized'
    );
  });

  test('expired claim terminalizes predecessors only after winning fenced CAS', async () => {
    const owner = await anonymousSession();
    userIds.push(owner.userId);
    const project = await prisma.project.create({
      data: {
        syncSalt: randomUUID(),
        userId: owner.userId,
        name: 'claim-takeover',
        repoUrl: 'https://github.com/fixture/current',
        templateSnapshotId: 'retained-template',
      },
    });
    const now = new Date();
    const input = {
      projectId: project.id,
      trigger: 'manual' as const,
      mode: 'sync' as const,
      fromSnapshotId: null,
      leaseMs: 60_000,
      now,
    };
    const first = await claimRun(input);
    assert(first.kind === 'claimed', 'initial claim admitted');
    if (first.kind !== 'claimed') throw new Error('claim missing');
    assert((await claimRun(input)).kind === 'busy', 'live owner cannot be replaced');
    assert(
      (
        await prisma.projectMaintenanceRun.findUniqueOrThrow({
          where: { id: first.run.id },
        })
      ).status === 'RUNNING',
      'losing live claim cannot terminalize owner'
    );
    await prisma.project.update({
      where: { id: project.id },
      data: {
        maintenanceLeaseUntil: new Date(now.getTime() - 1),
      },
    });
    assert(
      (
        await claimRun({
          ...input,
          expectedRepoUrl: 'https://github.com/fixture/stale',
        })
      ).kind === 'busy',
      'repo fence still rejects expired claim'
    );
    assert(
      (
        await prisma.projectMaintenanceRun.findUniqueOrThrow({
          where: { id: first.run.id },
        })
      ).status === 'RUNNING',
      'failed repo CAS leaves predecessor untouched'
    );
    const replacement = await claimRun({
      ...input,
      expectedRepoUrl: project.repoUrl!,
    });
    assert(replacement.kind === 'claimed', 'expired lease reclaimed');
    if (replacement.kind !== 'claimed') throw new Error('replacement missing');
    const old = await prisma.projectMaintenanceRun.findUniqueOrThrow({
      where: { id: first.run.id },
    });
    assert(
      old.status === 'FAILED' && old.finishedAt?.getTime() === now.getTime(),
      'predecessor terminal'
    );
    assert(
      (await prisma.projectMaintenanceRun.count({
        where: { projectId: project.id, status: 'RUNNING' },
      })) === 1,
      'exactly new run remains running, losing claims rolled back'
    );
    const publication = await publishSnapshot({
      projectId: project.id,
      runId: first.run.id,
      snapshotId: 'stale-template',
      sha: null,
      size: null,
      now,
    });
    assert(!publication.published, 'expired predecessor cannot publish');
    await finishRun({
      projectId: project.id,
      runId: first.run.id,
      status: 'FAILED',
      now,
      startedAt: first.run.startedAt,
    });
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    assert(
      row.maintenanceRunId === replacement.run.id && row.templateSnapshotId === 'retained-template',
      'late predecessor completion preserves replacement lease and snapshot'
    );
  });

  test('expired takeover and old completion overlap without inverted row locks', async () => {
    const owner = await anonymousSession();
    userIds.push(owner.userId);
    const project = await prisma.project.create({
      data: {
        userId: owner.userId,
        syncSalt: randomUUID(),
        name: 'overlap-claim-finish',
      },
    });
    for (let i = 0; i < 3; i += 1) {
      const now = new Date();
      const input = {
        projectId: project.id,
        trigger: 'manual' as const,
        mode: 'sync' as const,
        fromSnapshotId: null,
        leaseMs: 60_000,
        now,
      };
      const old = await claimRun(input);
      assert(old.kind === 'claimed', 'overlap initial claim');
      if (old.kind !== 'claimed') throw new Error('overlap missing claim');
      await prisma.project.update({
        where: { id: project.id },
        data: {
          maintenanceLeaseUntil: new Date(now.getTime() - 1),
        },
      });
      const [next] = await Promise.all([
        claimRun(input),
        finishRun({
          projectId: project.id,
          runId: old.run.id,
          status: 'FAILED',
          now,
          startedAt: old.run.startedAt,
        }),
      ]);
      assert(next.kind === 'claimed', 'takeover and completion both settle');
      if (next.kind !== 'claimed') throw new Error('overlap missing replacement');
      const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      assert(row.maintenanceRunId === next.run.id, 'old finish cannot release successor');
      assert(
        (await prisma.projectMaintenanceRun.findUniqueOrThrow({ where: { id: old.run.id } }))
          .status === 'FAILED',
        'old run terminal in either ordering'
      );
      await finishRun({
        projectId: project.id,
        runId: next.run.id,
        status: 'FAILED',
        now,
        startedAt: next.run.startedAt,
      });
    }
  });

  test('watch poll updates monotonic token without changing persisted edit timestamp', async () => {
    const owner = await anonymousSession();
    userIds.push(owner.userId);
    const project = await prisma.project.create({
      data: {
        userId: owner.userId,
        syncSalt: randomUUID(),
        name: 'watch-edit-timestamp',
        maintenanceScript: '  echo hi\n',
        updatedAt: new Date('2000-01-01T00:00:00Z'),
      },
    });
    const now = new Date();
    const first = await markWatchChecked(project.id, now);
    const second = await markWatchChecked(project.id, now);
    const backwards = await markWatchChecked(project.id, new Date(now.getTime() - 1000));
    assert(first !== null && second !== null && backwards !== null, 'persisted tokens exist');
    assert(second > first && backwards > second, 'identical and backwards clocks remain monotonic');
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    assert(
      after.updatedAt.getTime() === project.updatedAt.getTime(),
      'poll preserves edit timestamp'
    );
    assert(
      after.maintenanceScript === project.maintenanceScript,
      'poll preserves original script bytes'
    );
  });
}
