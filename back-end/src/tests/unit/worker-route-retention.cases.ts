import assert from 'node:assert/strict';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as API from '../../providers/workerDeploymentQueue';
import { execTypeScript } from '../../providers/processSafety';

type Identity = API.WorkerDeploymentIdentity;
export async function retainedRouteMismatchCases(ctx: {
  api: typeof API;
  prisma: PrismaClient;
  owner: string;
  app: string;
  identity: (app: string, attempt: string) => Identity;
}) {
  const { api, prisma, owner, app, identity } = ctx;
  const { setCurrentAgentQueue } = await import('../../providers/agentQueuePointer');
  process.env.TEMPORAL_NAMESPACE ??= 'retention-local-fixture';
  const original = await api.enqueueWorkerDeployment(identity(app, 'original'));
  const record = (id: string) => ({ id, instanceId: `native-${id}`, configSHA256: 'd'.repeat(64) });
  const oldIDs = Array.from({ length: 8 }, (_, i) => `retained-${i}`);
  const oldRecords = oldIDs.map(record);
  const prior = await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } });
  await api.prepareWorkerDeployment(
    original.jobId,
    {
      priorPointer: { taskQueue: prior.taskQueue, surfaceHash: prior.surfaceHash },
      candidateMachineIds: oldIDs,
      evidence: { candidateRecords: oldRecords, previousRecords: [] },
    },
    owner
  );
  await api.transitionWorkerDeployment(original.jobId, 'PREPARING', 'READY', {}, owner);
  const oldQueue = api.workerDeploymentQueueName(original.jobId, original.identity.surfaceHash);
  await prisma.agentQueuePointer.update({
    where: { id: 'singleton' },
    data: {
      taskQueue: oldQueue,
      surfaceHash: original.identity.surfaceHash,
      updatedBy: original.jobId,
    },
  });
  await api.transitionWorkerDeployment(original.jobId, 'READY', 'ACTIVATED', {}, owner);
  await api.transitionWorkerDeployment(original.jobId, 'ACTIVATED', 'DRAINING', {}, owner);
  await api.transitionWorkerDeployment(
    original.jobId,
    'DRAINING',
    'SUCCEEDED',
    {
      candidateHealthy: true,
      priorDisposition: 'RETAINED_LEGACY',
    },
    owner
  );
  const originalBytes = JSON.stringify(await api.readWorkerDeployment(original.jobId));
  const originals = await prisma.toolSideEffect.findMany({
    where: {
      operationType: 'WORKER_DEPLOYMENT_RESERVATION',
      externalId: app,
    },
    orderBy: { operationKey: 'asc' },
  });
  const next = await api.enqueueWorkerDeployment(identity(app, 'correction'));
  const ids = Array.from({ length: 8 }, (_, i) => `replacement-${i}`);
  const previousRecords = oldRecords.map((r) => ({ ...r, managedJobId: original.jobId }));
  const mismatch = previousRecords.map((r, i) => ({
    ...r,
    routeEvidence: {
      machineId: r.id,
      instanceId: r.instanceId,
      configSHA256: r.configSHA256,
      pid: 100 + i,
      started: 123456 + i,
      namespace: process.env.TEMPORAL_NAMESPACE!,
      expectedQueue: oldQueue,
      actualQueue: `navi-agent-tasks@${original.identity.surfaceHash}`,
      buildId: original.identity.buildId,
      surfaceHash: original.identity.surfaceHash,
      attempt: original.identity.attempt,
      identity: `${100 + i}@${r.id}`,
      autoscalerActuate: '0',
    },
  }));
  const preparation = {
    priorPointer: { taskQueue: oldQueue, surfaceHash: original.identity.surfaceHash },
    candidateMachineIds: ids,
    evidence: {
      candidateRecords: ids.map(record),
      previousRecords,
      retainedRouteMismatchRecords: mismatch,
    },
  };
  const reservation = `deployment:worker-machine:${app}:${ids[7]}`;
  await prisma.toolSideEffect.create({
    data: {
      operationKey: reservation,
      operationType: 'WORKER_DEPLOYMENT_RESERVATION',
      externalId: app,
      status: 'ACTIVE',
      request: { jobId: 'foreign' },
    },
  });
  await assert.rejects(
    api.prepareWorkerDeployment(next.jobId, preparation, owner),
    /reserved|active/
  );
  assert.equal(
    await prisma.toolSideEffect.count({
      where: {
        operationType: 'WORKER_DEPLOYMENT_RETENTION',
        externalId: app,
      },
    }),
    0,
    'failed atomic reservation leaves no partial hold'
  );
  await prisma.toolSideEffect.delete({ where: { operationKey: reservation } });
  for (const bad of [
    mismatch.slice(1),
    [...mismatch.slice(1), mismatch[1]],
    mismatch.map((r, i) => (i ? r : { ...r, managedJobId: 'foreign' })),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, actualQueue: oldQueue } }
    ),
    mismatch.map((r, i) => (i ? r : { ...r, routeEvidence: { ...r.routeEvidence, pid: 0 } })),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, buildId: 'f'.repeat(40) } }
    ),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, autoscalerActuate: '1' } }
    ),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, namespace: 'foreign' } }
    ),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, actualQueue: 'navi-agent-tasks@wrong' } }
    ),
    mismatch.map((r, i) =>
      i ? r : { ...r, routeEvidence: { ...r.routeEvidence, identity: '99999@foreign' } }
    ),
  ]) {
    // Original runtime accepts these unvalidated records: owning negative RED.
    await assert.rejects(
      api.prepareWorkerDeployment(
        next.jobId,
        {
          ...preparation,
          evidence: { ...preparation.evidence, retainedRouteMismatchRecords: bad },
        },
        owner
      ),
      /retention|mismatch|managed|proof/i
    );
  }
  await api.prepareWorkerDeployment(next.jobId, preparation, owner);
  assert.equal(
    await prisma.toolSideEffect.count({
      where: {
        operationType: 'WORKER_DEPLOYMENT_RETENTION',
        externalId: app,
        status: 'HELD',
      },
    }),
    8,
    'PREPARING must atomically preserve every prior managed worker'
  );
  assert.equal(JSON.stringify(await api.readWorkerDeployment(original.jobId)), originalBytes);
  assert.deepEqual(
    await prisma.toolSideEffect.findMany({
      where: {
        operationType: 'WORKER_DEPLOYMENT_RESERVATION',
        externalId: app,
        operationKey: { in: originals.map((r) => r.operationKey) },
      },
      orderBy: { operationKey: 'asc' },
    }),
    originals
  );
  await api.assertWorkerDeploymentMachineMutable(next.jobId, ids[0], owner);
  await assert.rejects(
    api.assertWorkerDeploymentMachineMutable(next.jobId, oldIDs[0], owner),
    /retained|held/i
  );
  await assert.rejects(
    api.assertWorkerDeploymentMachineMutable(next.jobId, 'foreign', owner),
    /bank|machine/i
  );
  await assert.rejects(
    api.assertWorkerDeploymentMachineMutable(next.jobId, ids[0], 'foreign'),
    /lease/i
  );
  await api.transitionWorkerDeployment(
    next.jobId,
    'PREPARING',
    'READY',
    { healthyMachineIds: ids },
    owner
  );
  const targetQueue = api.workerDeploymentQueueName(next.jobId, next.identity.surfaceHash);
  const gate = (queue: string, jobId: string) => ({
    version: 1,
    queue,
    incarnation: 'fixture-' + jobId,
    phase: 'OPEN',
    owner,
    surfaceHash: original.identity.surfaceHash,
    legacyCoverage: 'QUALIFIED',
    legacyCertificate: {
      producerTransition: `immutable-start-and-native-continuation-v1:${original.identity.sourceCommit}`,
      cohortManifest: `fresh:${jobId}`,
      unresolved: 0,
    },
  });
  for (const [queue, jobId] of [
    [oldQueue, original.jobId],
    [targetQueue, next.jobId],
  ])
    await prisma.toolSideEffect.create({
      data: {
        operationKey: `agent-queue-admission:${queue}`,
        operationType: 'AGENT_QUEUE_ADMISSION',
        externalId: queue,
        status: 'OPEN',
        request: gate(queue, jobId),
      },
    });
  for (const operationType of ['AGENT_QUEUE_START', 'AGENT_QUEUE_CONTINUATION']) {
    for (const status of ['STARTED', 'COMPLETED']) {
      const membership = await prisma.toolSideEffect.create({
        data: {
          operationKey: 'retention-test-membership-' + next.jobId,
          operationType,
          status,
          request: { queue: oldQueue },
        },
      });
      await assert.rejects(
        setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
          expectedCurrentQueue: oldQueue,
          deploymentOwnerId: owner,
        }),
        /membership|member|empty/i
      );
      assert.equal(
        (await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } }))
          .taskQueue,
        oldQueue
      );
      assert.equal(
        (
          (
            await prisma.toolSideEffect.findUniqueOrThrow({
              where: { operationKey: `agent-queue-admission:${oldQueue}` },
            })
          ).request as { phase: string }
        ).phase,
        'OPEN'
      );
      await prisma.toolSideEffect.delete({ where: { id: membership.id } });
    }
  }
  const { claimWorkflowStart } = await import('../../providers/workflowQueueAdmission');
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racing = claimWorkflowStart(
    'racing-agent',
    'racing-workflow',
    oldQueue,
    true,
    Date.now() + 20000,
    (operation) =>
      prisma.$transaction(async (tx) => {
        const intent = await operation(tx);
        entered();
        await unblock;
        return intent;
      })
  );
  await admitted;
  const blockedPublication = setCurrentAgentQueue(
    targetQueue,
    next.identity.surfaceHash,
    next.jobId,
    { expectedCurrentQueue: oldQueue, deploymentOwnerId: owner }
  );
  const rejectedPublication = assert.rejects(blockedPublication, /membership|member|empty/i);
  release();
  const racedIntent = await racing;
  await rejectedPublication;
  assert.equal(
    (await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } })).taskQueue,
    oldQueue
  );
  await prisma.toolSideEffect.delete({
    where: { operationKey: `agent-queue-start:${racedIntent.id}` },
  });
  const schema = new URL(process.env.DATABASE_URL!).searchParams.get('schema');
  assert.match(schema!, /^worker_deployment_[a-f0-9]+$/);
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${schema}".retention_deny_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture publication rejected'; END $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER retention_deny_pointer BEFORE UPDATE ON "${schema}"."AgentQueuePointer" FOR EACH ROW EXECUTE FUNCTION "${schema}".retention_deny_pointer()`
  );
  try {
    await assert.rejects(
      setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
        expectedCurrentQueue: oldQueue,
        deploymentOwnerId: owner,
      }),
      /fixture publication rejected/
    );
    assert.equal(
      (await prisma.agentQueuePointer.findUniqueOrThrow({ where: { id: 'singleton' } })).taskQueue,
      oldQueue
    );
    assert.equal(
      (
        (
          await prisma.toolSideEffect.findUniqueOrThrow({
            where: { operationKey: `agent-queue-admission:${oldQueue}` },
          })
        ).request as { phase: string }
      ).phase,
      'OPEN'
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER retention_deny_pointer ON "${schema}"."AgentQueuePointer"`
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}".retention_deny_pointer()`);
  }

  await setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
    expectedCurrentQueue: oldQueue,
    deploymentOwnerId: owner,
  });
  const fenced = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: `agent-queue-admission:${oldQueue}` },
  });
  assert.equal((fenced.request as { phase: string }).phase, 'RETIRING');
  assert.equal((fenced.request as { owner: string }).owner, next.jobId);
  await setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
    expectedCurrentQueue: oldQueue,
    deploymentOwnerId: owner,
  });
  await prisma.toolSideEffect.update({
    where: { id: fenced.id },
    data: { request: { ...(fenced.request as object), owner: 'foreign' } },
  });
  await assert.rejects(
    setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
      expectedCurrentQueue: oldQueue,
      deploymentOwnerId: owner,
    }),
    /foreign|unqualified/i
  );
  await prisma.toolSideEffect.update({
    where: { id: fenced.id },
    data: { status: 'RETIRED', request: { ...(fenced.request as object), phase: 'RETIRED' } },
  });
  await setCurrentAgentQueue(targetQueue, next.identity.surfaceHash, next.jobId, {
    expectedCurrentQueue: oldQueue,
    deploymentOwnerId: owner,
  });
  assert.equal(
    (
      (await prisma.toolSideEffect.findUniqueOrThrow({ where: { id: fenced.id } })).request as {
        phase: string;
      }
    ).phase,
    'RETIRED'
  );
  await prisma.toolSideEffect.update({
    where: { id: fenced.id },
    data: { status: 'RETIRING', request: fenced.request! },
  });
  const redirected = await claimWorkflowStart(
    'stale-cache-agent',
    'stale-cache-workflow',
    oldQueue,
    true,
    Date.now() + 20000
  );
  assert.equal(redirected.queue, targetQueue);
  assert.equal(redirected.requestedQueue, oldQueue);
  assert.equal(redirected.wireCoverage, 'IMMUTABLE_ID');
  await api.transitionWorkerDeployment(next.jobId, 'READY', 'ACTIVATED', {}, owner);
  await api.transitionWorkerDeployment(next.jobId, 'ACTIVATED', 'DRAINING', {}, owner);
  await assert.rejects(
    api.transitionWorkerDeployment(
      next.jobId,
      'DRAINING',
      'SUCCEEDED',
      {
        candidateHealthy: true,
        priorDisposition: 'RETAINED_LEGACY',
      },
      owner
    ),
    /Managed prior/
  );
  const done = {
    candidateHealthy: true,
    priorDisposition: 'RETAINED_ROUTE_MISMATCH',
    activeMachineIds: ids,
    retainedRouteMismatchMachineIds: oldIDs,
    retainedLegacyMachineIds: [],
    retiredMachines: [],
  };
  await assert.rejects(
    api.transitionWorkerDeployment(
      next.jobId,
      'DRAINING',
      'SUCCEEDED',
      {
        ...done,
        retainedRouteMismatchMachineIds: oldIDs.slice(1),
      },
      owner
    ),
    /retention|mismatch|bank/i
  );
  await assert.rejects(
    api.releaseRetiredWorkerMachines(
      next.jobId,
      [
        {
          machineId: oldIDs[0],
          previousJobId: original.jobId,
          instanceId: 'stopped',
          configSHA256: 'd'.repeat(64),
          retiredQueue: oldQueue,
          certificateRef: 'fake-wrong-queue',
        },
      ],
      owner
    ),
    /retained|held/i
  );
  await assert.rejects(
    api.transitionWorkerDeployment(next.jobId, 'DRAINING', 'SUCCEEDED', done, owner),
    /unqualified|retire/i
  );
  const oldGate = fenced.request as { phase: string };
  await prisma.toolSideEffect.update({
    where: { id: fenced.id },
    data: { status: 'RETIRED', request: { ...oldGate, phase: 'RETIRED' } },
  });
  await api.transitionWorkerDeployment(next.jobId, 'DRAINING', 'SUCCEEDED', done, owner);
  const report = await api.readWorkerDeploymentRetainedRouteMismatch(next.jobId);
  assert.deepEqual(report.machineIds.sort(), oldIDs.sort());
  assert.equal(report.retirementComplete, false);
  assert.equal(report.unresolved, 8);
  assert.deepEqual(report.actualQueues, [`navi-agent-tasks@${original.identity.surfaceHash}`]);
  assert.equal(JSON.stringify(await api.readWorkerDeployment(original.jobId)), originalBytes);
  const monitor = path.resolve(__dirname, '../../../scripts/monitor-cooperative-cutover.ts');
  const result = await execTypeScript([monitor, '--job-id', next.jobId, '--json', '--verify']);
  const reportStart = result.stdout.indexOf('{\n  "phase"');
  assert.ok(reportStart >= 0);
  const monitored = JSON.parse(result.stdout.slice(reportStart));
  assert.equal(monitored.phase, 'retained_route_mismatch');
  assert.equal(monitored.oldQueueOpenCount, null);
  assert.equal(monitored.retainedRouteMismatch.unresolved, 8);
  assert.equal(monitored.retainedRouteMismatch.retirementComplete, false);
  const hold = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: `deployment:worker-route-retention:${app}:${oldIDs[0]}` },
  });
  await prisma.toolSideEffect.update({ where: { id: hold.id }, data: { status: 'RELEASED' } });
  await assert.rejects(
    api.readWorkerDeploymentRetainedRouteMismatch(next.jobId),
    /retention|mismatch/i
  );
  await assert.rejects(execTypeScript([monitor, '--job-id', next.jobId, '--json', '--verify']));
  await prisma.toolSideEffect.update({ where: { id: hold.id }, data: { status: 'HELD' } });
  const future = await api.enqueueWorkerDeployment(identity(app, 'future'));
  const currentPointer = await prisma.agentQueuePointer.findUniqueOrThrow({
    where: { id: 'singleton' },
  });
  await assert.rejects(
    api.prepareWorkerDeployment(
      future.jobId,
      {
        priorPointer: {
          taskQueue: currentPointer.taskQueue,
          surfaceHash: currentPointer.surfaceHash,
        },
        candidateMachineIds: oldIDs,
        evidence: { candidateRecords: oldRecords, previousRecords: [] },
      },
      owner
    ),
    /retained|held/i
  );
  await assert.rejects(
    api.assertWorkerDeploymentMachineMutable(next.jobId, oldIDs[0], owner),
    /terminal|FIFO|held|retained/i
  );
}
