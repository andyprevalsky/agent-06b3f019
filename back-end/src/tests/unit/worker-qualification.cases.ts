import assert from 'node:assert/strict';
import path from 'node:path';
import type * as API from '../../providers/workerDeploymentQueue';
import type { PrismaClient } from '@prisma/client';
import { execTypeScript } from '../../providers/processSafety';

type Ctx = {
  api: typeof API;
  prisma: PrismaClient;
  appFor: (name: string) => string;
  identity: (app: string, attempt: string) => API.WorkerDeploymentIdentity;
};

export async function qualificationCases({ api, prisma, appFor, identity }: Ctx) {
  const { readWorkerDeploymentQualification } =
    await import('../../../scripts/production-worker-qualification');
  const app = appFor('qualification');
  const absentSource = 'd'.repeat(40);
  const original = await api.enqueueWorkerDeployment(identity(app, 'original'));
  const terminal = { ...original, stage: 'ABORTED' as const };
  await prisma.toolSideEffect.update({
    where: { operationKey: `deployment:worker-job:${original.jobId}` },
    data: { status: terminal.stage, request: terminal },
  });
  const live = await api.enqueueWorkerDeployment({
    ...identity(app, 'live'),
    sourceCommit: 'e'.repeat(40),
    buildId: 'e'.repeat(40),
  });
  const prior = await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } });
  try {
    await prisma.agentQueuePointer.update({
      where: { id: 'singleton' },
      data: { updatedBy: live.jobId },
    });
    const before = await prisma.toolSideEffect.findMany({
      where: { externalId: app },
      orderBy: { operationKey: 'asc' },
    });
    const absent = await readWorkerDeploymentQualification(app, absentSource);
    assert.deepEqual(absent.originalJobs, []);
    assert.equal(absent.liveJob?.jobId, live.jobId);
    assert.equal(absent.livePointer?.updatedBy, live.jobId);
    const existing = await readWorkerDeploymentQualification(app, original.identity.sourceCommit);
    assert.deepEqual(
      existing.originalJobs.map((job) => [job.jobId, job.stage]),
      [[original.jobId, 'ABORTED']]
    );
    assert.deepEqual(
      await prisma.toolSideEffect.findMany({
        where: { externalId: app },
        orderBy: { operationKey: 'asc' },
      }),
      before
    );
    await assert.rejects(
      readWorkerDeploymentQualification(app, 'invalid'),
      /Invalid qualification/
    );
    const cli = path.resolve(__dirname, '../../../scripts/production-worker-qualification.ts');
    await assert.rejects(execTypeScript([cli, '--app', app]), /--source is required/);
    await assert.rejects(execTypeScript([cli, '--source', absentSource]), /--app is required/);
  } finally {
    await prisma.agentQueuePointer.update({
      where: { id: 'singleton' },
      data: { updatedBy: prior.updatedBy },
    });
  }
}
