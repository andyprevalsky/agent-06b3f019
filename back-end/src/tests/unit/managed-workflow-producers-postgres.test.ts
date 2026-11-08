import assert from 'node:assert/strict';
import { WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { prisma } from '../../providers/database';
import { initializeManagedQueue } from '../../providers/workflowManagedQueue';
import { setCurrentAgentQueue } from '../../providers/agentQueuePointer';
import { startAgentWorkflowExecutionWithClient } from '../../providers/temporal';
import { admitQueueContinuation } from '../../providers/workflowQueueContinuation';
import {
  beginQueueRetirement,
  requireQueueRetirementReady,
} from '../../providers/workflowQueueAdmission';
async function main() {
  assert.equal(nonLocalDatabaseReason(process.env.DATABASE_URL), null);
  const schema = `managed_producer_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  // The engine's one-time TLS setenv must finish before another client reads process.env.
  await prisma.$connect();
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const original = prisma.$transaction;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."ToolSideEffect" ("id" TEXT PRIMARY KEY, "operationKey" TEXT NOT NULL UNIQUE, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'STARTED', "externalId" TEXT, "request" JSONB, "response" JSONB, "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL)`
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."AgentQueuePointer" ("id" TEXT PRIMARY KEY, "taskQueue" TEXT NOT NULL, "surfaceHash" TEXT NOT NULL, "updatedBy" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL)`
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."Agent" ("id" TEXT PRIMARY KEY, "deletedAt" TIMESTAMP(3), "temporalWorkflowId" TEXT, "temporalFirstExecutionRunId" TEXT, "workflowReplacementToken" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`
    );
    await db.$executeRawUnsafe(`INSERT INTO "${schema}"."Agent" ("id") VALUES ('logical-agent')`);
    prisma.$transaction = db.$transaction.bind(db) as typeof prisma.$transaction;
    await db.toolSideEffect.create({
      data: {
        operationKey: 'deployment:temporal-workflow-cutover',
        operationType: 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE',
        status: 'STARTED',
        externalId: 'owner',
        request: { leaseMs: 120000 },
      },
    });
    const jobId = 'real-pg-job',
      surfaceHash = 'a'.repeat(12);
    const queue = `navi-agent-tasks-pool-${createHash('sha256').update(jobId).digest('hex').slice(0, 12)}@${surfaceHash}`;
    const input = { queue, surfaceHash, jobId, sourceCommit: 'b'.repeat(40) };
    await assert.rejects(initializeManagedQueue(input, 'wrong-owner'), /lease/);
    await db.toolSideEffect.create({
      data: {
        operationKey: `deployment:worker-job:${jobId}`,
        operationType: 'WORKER_DEPLOYMENT_JOB',
        request: {
          version: 1,
          jobId,
          stage: 'PREPARING',
          ownerId: 'owner',
          identity: { sourceCommit: input.sourceCommit, surfaceHash },
        },
      },
    });
    await assert.rejects(
      initializeManagedQueue({ ...input, sourceCommit: 'c'.repeat(40) }, 'owner'),
      /matching owned deployment job/
    );
    await db.$executeRawUnsafe(
      `UPDATE "${schema}"."ToolSideEffect" SET "updatedAt" = CURRENT_TIMESTAMP - interval '130 seconds' WHERE "operationKey" = 'deployment:temporal-workflow-cutover'`
    );
    await assert.rejects(initializeManagedQueue(input, 'owner'), /lease/);
    await db.$executeRawUnsafe(
      `UPDATE "${schema}"."ToolSideEffect" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = 'deployment:temporal-workflow-cutover'`
    );
    await initializeManagedQueue(input, 'owner');
    const gateKey = `agent-queue-admission:${queue}`;
    const before = await db.toolSideEffect.findUniqueOrThrow({ where: { operationKey: gateKey } });
    await initializeManagedQueue(input, 'owner');
    assert.deepEqual(
      (await db.toolSideEffect.findUniqueOrThrow({ where: { operationKey: gateKey } })).request,
      before.request
    );
    const calls: Array<{ workflowId: string; workflowIdReusePolicy: string; args: unknown[] }> = [];
    const client = {
      withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
      workflow: {
        getHandle: () => ({
          describe: async () => {
            throw new WorkflowNotFoundError('offline absent', 'logical-agent', undefined);
          },
        }),
        start: async (
          _t: string,
          o: { workflowId: string; workflowIdReusePolicy: string; args: unknown[] }
        ) => {
          calls.push(o);
          return { workflowId: o.workflowId, firstExecutionRunId: 'native-first' };
        },
      },
    };
    const params = {
      agentId: 'logical-agent',
      userId: 'user',
      goal: 'same logical goal',
      model: 'test',
      reasoningMaxTokens: 2048,
      verifier: { type: 'test' },
      taskQueue: queue,
    };
    await assert.rejects(
      startAgentWorkflowExecutionWithClient(client as never, params),
      /published/
    );
    assert.equal(calls.length, 0);
    const candidateMachineIds = Array.from({ length: 8 }, (_, index) => `candidate-${index}`);
    await db.toolSideEffect.update({
      where: { operationKey: `deployment:worker-job:${jobId}` },
      data: {
        request: {
          version: 1,
          jobId,
          stage: 'READY',
          ownerId: 'owner',
          identity: { sourceCommit: input.sourceCommit, surfaceHash },
          candidateMachineIds,
          evidence: { READY: { healthyMachineIds: candidateMachineIds } },
        },
      },
    });
    await db.agentQueuePointer.create({
      data: { id: 'singleton', taskQueue: 'legacy-old-served', surfaceHash: 'c'.repeat(12) },
    });
    await setCurrentAgentQueue(queue, surfaceHash, jobId, {
      expectedCurrentQueue: 'legacy-old-served',
      deploymentOwnerId: 'owner',
    });
    const results = await Promise.all([
      startAgentWorkflowExecutionWithClient(client as never, params),
      startAgentWorkflowExecutionWithClient(client as never, params),
    ]);
    assert.equal(results[0].workflowId, results[1].workflowId);
    assert.notEqual(results[0].workflowId, params.agentId);
    assert(
      calls.every(
        (c) => c.workflowIdReusePolicy === 'REJECT_DUPLICATE' && c.args[0] === params.agentId
      )
    );
    assert.equal(
      await db.toolSideEffect.count({ where: { operationType: 'AGENT_PHYSICAL_START' } }),
      1
    );
    const source = { workflowId: 'incoming-legacy-chain', runId: 'source-run' };
    const native = {
      firstExecutionRunId: 'incoming-first',
      runId: source.runId,
      queue: 'legacy-old-served',
      terminal: false,
    };
    await admitQueueContinuation(source, async () => native);
    await db.agentQueuePointer.update({
      where: { id: 'singleton' },
      data: { taskQueue: 'new-destination' },
    });
    await beginQueueRetirement(queue, 'retirement-owner');
    const reconcile = async (ref: { workflowId: string }) =>
      ref.workflowId === source.workflowId
        ? native
        : {
            firstExecutionRunId: 'native-first',
            runId: 'ended',
            queue: 'new-destination',
            terminal: true,
          };
    await assert.rejects(
      requireQueueRetirementReady(queue, 'retirement-owner', reconcile),
      /Continuation/
    );
    native.runId = 'continued-run';
    native.queue = 'new-destination';
    await requireQueueRetirementReady(queue, 'retirement-owner', reconcile);
    assert.equal(
      (
        (await db.toolSideEffect.findUniqueOrThrow({ where: { operationKey: gateKey } }))
          .request as { phase: string }
      ).phase,
      'RETIRED'
    );
    await assert.rejects(initializeManagedQueue(input, 'owner'), /not fresh/);
    await initializeManagedQueue(input, 'owner', { forRetirement: true });
    assert.equal(
      (
        (await db.toolSideEffect.findUniqueOrThrow({ where: { operationKey: gateKey } }))
          .request as { phase: string }
      ).phase,
      'RETIRED'
    );
    process.stdout.write(
      'PASS actual Postgres lease/resume/staged0wire/concurrent-root/inbound-CAN/retirement\n'
    );
  } finally {
    prisma.$transaction = original;
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
