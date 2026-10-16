import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { setCurrentAgentQueue } from '../../providers/agentQueuePointer';
import { WORKFLOW_DEPLOYMENT_LEASE_KEY } from '../../providers/workflowDeploymentLease';
import { workerDeploymentQueueName } from '../../providers/workerDeploymentQueue';
import { MANAGED_PRODUCER_PROTOCOL } from '../../providers/workflowManagedQueue';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('worker deployment pointer ownership');
async function main() {
  const original = prisma.$transaction;
  const at = new Date('2026-01-01T00:00:00.000Z');
  try {
    for (const scenario of [
      'current',
      'expired',
      'replaced',
      'invalid-duration',
      'changed-pointer',
    ]) {
      await test(scenario, async () => {
        const events: string[] = [];
        const tx = {
          $executeRaw: async () => {
            events.push('lock');
            return 1;
          },
          $queryRaw: async () => [{ now: at }],
          toolSideEffect: {
            findUnique: async ({ where }: { where: { operationKey: string } }) => {
              if (where.operationKey === WORKFLOW_DEPLOYMENT_LEASE_KEY)
                return {
                  operationType: 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE',
                  status: 'STARTED',
                  externalId: scenario === 'replaced' ? 'other' : 'owner',
                  updatedAt: new Date(at.getTime() - (scenario === 'expired' ? 2000 : 100)),
                  request: { leaseMs: scenario === 'invalid-duration' ? Infinity : 1000 },
                };
              return {
                request: { version: 1, queue: 'new', phase: 'OPEN', surfaceHash: 'surface' },
              };
            },
          },
          agentQueuePointer: {
            findUnique: async () => ({
              taskQueue: scenario === 'changed-pointer' ? 'foreign' : 'old',
            }),
            upsert: async () => {
              events.push('publish');
            },
          },
        };
        prisma.$transaction = (async (fn: (client: unknown) => unknown) => fn(tx)) as never;
        const operation = setCurrentAgentQueue('new', 'surface', 'job', {
          expectedCurrentQueue: 'old',
          deploymentOwnerId: 'owner',
        });
        if (scenario === 'current') {
          await operation;
          assert.equal(events.at(-1), 'publish');
        } else {
          await assert.rejects(operation);
          assert(!events.includes('publish'));
        }
        assert.equal(events[0], 'lock');
      });
    }
    for (const scenario of [
      'ready',
      'missing-owner',
      'not-ready',
      'missing-bank',
      'unqualified',
      'foreign-certificate',
    ]) {
      await test(`managed ${scenario}`, async () => {
        const jobId = 'a'.repeat(64);
        const surface = 'b'.repeat(12);
        const queue = workerDeploymentQueueName(jobId, surface);
        const ids = Array.from({ length: 8 }, (_, i) => `machine-${i}`);
        let published = false;
        const tx = {
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ now: at }],
          toolSideEffect: {
            findUnique: async ({ where }: { where: { operationKey: string } }) => {
              if (where.operationKey === WORKFLOW_DEPLOYMENT_LEASE_KEY)
                return {
                  operationType: 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE',
                  status: 'STARTED',
                  externalId: 'owner',
                  updatedAt: at,
                  request: { leaseMs: 1000 },
                };
              if (where.operationKey.startsWith('deployment:worker-job:'))
                return {
                  operationType: 'WORKER_DEPLOYMENT_JOB',
                  request: {
                    jobId,
                    ownerId: 'owner',
                    stage: scenario === 'not-ready' ? 'PREPARING' : 'READY',
                    identity: { surfaceHash: surface, sourceCommit: 'c'.repeat(40) },
                    candidateMachineIds: ids,
                    evidence: {
                      READY: {
                        healthyMachineIds: scenario === 'missing-bank' ? ids.slice(1) : ids,
                      },
                    },
                  },
                };
              return {
                operationType: 'AGENT_QUEUE_ADMISSION',
                request: {
                  version: 1,
                  queue,
                  phase: 'OPEN',
                  surfaceHash: surface,
                  legacyCoverage: scenario === 'unqualified' ? 'UNKNOWN' : 'QUALIFIED',
                  legacyCertificate: {
                    cohortManifest: `fresh:${scenario === 'foreign-certificate' ? 'other' : jobId}`,
                    producerTransition: `${MANAGED_PRODUCER_PROTOCOL}:${'c'.repeat(40)}`,
                    unresolved: 0,
                  },
                },
              };
            },
          },
          agentQueuePointer: {
            findUnique: async () => ({ taskQueue: 'old' }),
            upsert: async () => {
              published = true;
            },
          },
        };
        prisma.$transaction = (async (fn: (client: unknown) => unknown) => fn(tx)) as never;
        const operation = setCurrentAgentQueue(queue, surface, jobId, {
          expectedCurrentQueue: 'old',
          ...(scenario === 'missing-owner' ? {} : { deploymentOwnerId: 'owner' }),
        });
        if (scenario === 'ready') await operation;
        else await assert.rejects(operation);
        assert.equal(published, scenario === 'ready');
      });
    }
  } finally {
    prisma.$transaction = original;
    await prisma.$disconnect();
  }
  finish();
}
void main();
