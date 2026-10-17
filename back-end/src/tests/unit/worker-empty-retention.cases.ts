import assert from 'node:assert/strict';
import type { Prisma, PrismaClient } from '@prisma/client';
import type * as API from '../../providers/workerDeploymentQueue';

export async function emptyRetentionCases(ctx: {
  api: typeof API;
  prisma: PrismaClient;
  owner: string;
  app: string;
  identity: (app: string, attempt: string) => API.WorkerDeploymentIdentity;
}) {
  const { api, prisma, owner, app, identity } = ctx;
  const { setCurrentAgentQueue } = await import('../../providers/agentQueuePointer');
  const saved = await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } });
  let prior = { taskQueue: saved.taskQueue, surfaceHash: saved.surfaceHash };
  let previousRecords: Array<{
    id: string;
    instanceId: string;
    configSHA256: string;
    managedJobId: string;
  }> = [];
  try {
    for (const generation of ['legacy', 'managed']) {
      const job = await api.enqueueWorkerDeployment(identity(app, generation));
      const ids = Array.from({ length: 8 }, (_, i) => `empty-${generation}-${i}`);
      const candidateRecords = ids.map((id) => ({
        id,
        instanceId: `version-${id}`,
        configSHA256: 'd'.repeat(64),
      }));
      const preparation = {
        priorPointer: prior,
        candidateMachineIds: ids,
        evidence: { candidateRecords, previousRecords, retainedRouteMismatchRecords: [] },
      };
      for (const invalid of [null, {}, 'bad', [null]]) {
        await assert.rejects(
          api.prepareWorkerDeployment(
            job.jobId,
            {
              ...preparation,
              evidence: { ...preparation.evidence, retainedRouteMismatchRecords: invalid },
            },
            owner
          ),
          /retention|mismatch|proof/i
        );
        assert.equal((await api.readWorkerDeployment(job.jobId)).stage, 'QUEUED');
      }
      await api.prepareWorkerDeployment(job.jobId, preparation, owner);
      await api.prepareWorkerDeployment(job.jobId, preparation, owner);
      await api.transitionWorkerDeployment(
        job.jobId,
        'PREPARING',
        'READY',
        { healthyMachineIds: ids },
        owner
      );
      const queue = api.workerDeploymentQueueName(job.jobId, job.identity.surfaceHash);
      await prisma.toolSideEffect.create({
        data: {
          operationKey: `agent-queue-admission:${queue}`,
          operationType: 'AGENT_QUEUE_ADMISSION',
          externalId: queue,
          status: 'OPEN',
          request: {
            version: 1,
            queue,
            incarnation: `empty-${generation}`,
            owner: job.jobId,
            phase: 'OPEN',
            surfaceHash: job.identity.surfaceHash,
            legacyCoverage: 'QUALIFIED',
            legacyCertificate: {
              producerTransition: `immutable-start-and-native-continuation-v1:${job.identity.sourceCommit}`,
              cohortManifest: `fresh:${job.jobId}`,
              unresolved: 0,
            },
          },
        },
      });
      await setCurrentAgentQueue(queue, job.identity.surfaceHash, job.jobId, {
        expectedCurrentQueue: prior.taskQueue,
        deploymentOwnerId: owner,
      });
      await api.transitionWorkerDeployment(job.jobId, 'READY', 'ACTIVATED', {}, owner);
      await api.transitionWorkerDeployment(job.jobId, 'ACTIVATED', 'DRAINING', {}, owner);
      if (generation === 'managed') {
        await assert.rejects(
          api.transitionWorkerDeployment(
            job.jobId,
            'DRAINING',
            'SUCCEEDED',
            {
              candidateHealthy: true,
              priorDisposition: 'RETIRED',
            },
            owner
          ),
          /retirement|unqualified|certificate/i
        );
        const row = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: `agent-queue-admission:${prior.taskQueue}` },
        });
        const gate = row.request as Prisma.JsonObject;
        await prisma.toolSideEffect.update({
          where: { id: row.id },
          data: { status: 'RETIRED', request: { ...gate, phase: 'RETIRED', owner: job.jobId } },
        });
        await api.releaseRetiredWorkerMachines(
          job.jobId,
          previousRecords.map((r) => ({
            machineId: r.id,
            previousJobId: r.managedJobId,
            instanceId: 'retired-version',
            configSHA256: r.configSHA256,
            retiredQueue: prior.taskQueue,
            certificateRef: `agent-queue-admission:${prior.taskQueue}`,
          })),
          owner
        );
      }
      await api.transitionWorkerDeployment(
        job.jobId,
        'DRAINING',
        'SUCCEEDED',
        {
          candidateHealthy: true,
          activeMachineIds: ids,
          priorDisposition: generation === 'legacy' ? 'RETAINED_LEGACY' : 'RETIRED',
        },
        owner
      );
      assert.equal((await api.readWorkerDeployment(job.jobId)).stage, 'SUCCEEDED');
      assert.equal(
        await prisma.toolSideEffect.count({
          where: {
            operationType: 'WORKER_DEPLOYMENT_RETENTION',
            externalId: app,
          },
        }),
        0
      );
      previousRecords = candidateRecords.map((r) => ({ ...r, managedJobId: job.jobId }));
      prior = { taskQueue: queue, surfaceHash: job.identity.surfaceHash };
    }
  } finally {
    await prisma.agentQueuePointer.update({
      where: { id: 'singleton' },
      data: {
        taskQueue: saved.taskQueue,
        surfaceHash: saved.surfaceHash,
        updatedBy: saved.updatedBy,
      },
    });
  }
}
