import { qualificationCases } from './worker-qualification.cases';
import { emptyRetentionCases } from './worker-empty-retention.cases';
import { retainedRouteMismatchCases } from './worker-route-retention.cases';
import {
  coalesceCases,
  coalesceCliCases,
  newerReleaseControllerCases,
} from './worker-deployment-coalesce.cases';
import { transientAssertionCase } from './worker-deployment-transient.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { on } from 'node:events';
import type { Readable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { execTypeScript, spawnTypeScript, typeScriptProcess } from '../../providers/processSafety';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
let prisma: typeof import('../../providers/database').prisma;
let api: typeof import('../../providers/workerDeploymentQueue');
let acquireWorkflowDeploymentLease: typeof import('../../providers/workflowDeploymentLease').acquireWorkflowDeploymentLease;
let queueAdmissionKey: typeof import('../../providers/workflowQueueAdmission').queueAdmissionKey;
let test: ReturnType<typeof import('./trace-archive-test-utils').createTestHarness>['test'];
let finish: ReturnType<typeof import('./trace-archive-test-utils').createTestHarness>['finish'];
const prefix = `queue-test-${randomUUID()}`;
const apps: string[] = [];
const appFor = (name: string) => {
  const app = `${prefix}-${name}`;
  apps.push(app);
  return app;
};
const identity = (app: string, attempt: string) => ({
  app,
  sourceCommit: 'a'.repeat(40),
  buildId: 'a'.repeat(40),
  surfaceHash: 'b'.repeat(12),
  attempt,
  imageRef: `registry.fly.io/${app}@sha256:${'c'.repeat(64)}`,
});
let priorFixture = { taskQueue: 'legacy-queue', surfaceHash: 'old' };
const plan = (prefix: string, priorPointer = priorFixture) => {
  const candidateMachineIds = Array.from({ length: 8 }, (_, i) => `${prefix}-${i}`);
  return {
    priorPointer,
    candidateMachineIds,
    evidence: {
      candidateRecords: candidateMachineIds.map((id) => ({
        id,
        instanceId: `boot-${id}`,
        configSHA256: 'd'.repeat(64),
      })),
      previousRecords: [],
    },
  };
};
async function fifo(owner: string) {
  const app = appFor('fifo');
  const first = identity(app, 'first');
  const [a, same] = await Promise.all([
    api.enqueueWorkerDeployment(first),
    api.enqueueWorkerDeployment(first),
  ]);
  assert.equal(a.jobId, same.jobId);
  const b = await api.enqueueWorkerDeployment(identity(app, 'second'));
  await assert.rejects(api.prepareWorkerDeployment(b.jobId, plan('second'), owner), /FIFO/);
  const extraFields = { ...plan('first'), identity: identity(app, 'must-not-replace-identity') };
  await api.prepareWorkerDeployment(a.jobId, extraFields, owner);
  assert.equal((await api.readWorkerDeployment(a.jobId)).identity.attempt, 'first');
  await Promise.all([
    api.prepareWorkerDeployment(a.jobId, plan('first'), owner),
    api.prepareWorkerDeployment(a.jobId, plan('first'), owner),
  ]);
  await api.recordWorkerDeploymentFailure(a.jobId, 'native response lost; retain bank', owner);
  await assert.rejects(api.assertWorkerDeploymentOwned(b.jobId, owner), /FIFO/);
  assert.equal((await api.readWorkerDeploymentHead(app))?.jobId, a.jobId);
  assert.deepEqual(
    (await api.readWorkerDeployment(a.jobId)).candidateMachineIds,
    plan('first').candidateMachineIds
  );
  await assert.rejects(api.prepareWorkerDeployment(a.jobId, plan('different'), owner), /immutable/);
  await assert.rejects(
    api.transitionWorkerDeployment(a.jobId, 'PREPARING', 'SUCCEEDED', {}, owner),
    /transition/
  );
  await assert.rejects(
    api.abortWorkerDeployment(a.jobId, 'unsafe prepared abort', owner),
    /reconciliation/
  );
  await api.prepareWorkerDeployment(a.jobId, plan('first'), owner);
  assert.equal((await api.readWorkerDeployment(a.jobId)).failure, null);
}
async function atomic(owner: string) {
  const app = appFor('atomic');
  const a = await api.enqueueWorkerDeployment(identity(app, 'atomic'));
  const p = plan('atomic');
  await prisma.toolSideEffect.create({
    data: {
      operationKey: `deployment:worker-machine:${app}:atomic-7`,
      operationType: 'WORKER_DEPLOYMENT_RESERVATION',
      externalId: app,
      status: 'ACTIVE',
      request: { jobId: 'foreign' },
    },
  });
  await assert.rejects(api.prepareWorkerDeployment(a.jobId, p, owner), /reserved/);
  assert.equal(
    await prisma.toolSideEffect.count({
      where: { operationType: 'WORKER_DEPLOYMENT_RESERVATION', externalId: app },
    }),
    1
  );
  assert.equal((await api.readWorkerDeployment(a.jobId)).stage, 'QUEUED');
  await assert.rejects(
    api.prepareWorkerDeployment(a.jobId, { ...p, candidateMachineIds: ['one'] }, owner),
    /candidate/
  );
  await assert.rejects(
    api.prepareWorkerDeployment(a.jobId, { ...p, evidence: {} }, owner),
    /records/
  );
}
async function activate(
  job: Awaited<ReturnType<typeof api.enqueueWorkerDeployment>>,
  p: ReturnType<typeof plan>,
  owner: string
) {
  await api.prepareWorkerDeployment(job.jobId, p, owner);
  await api.transitionWorkerDeployment(job.jobId, 'PREPARING', 'READY', {}, owner);
  await api.transitionWorkerDeployment(job.jobId, 'PREPARING', 'READY', {}, owner); // lost phase ACK
  const queue = api.workerDeploymentQueueName(job.jobId, job.identity.surfaceHash);
  priorFixture = { taskQueue: queue, surfaceHash: job.identity.surfaceHash };
  await prisma.agentQueuePointer.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', taskQueue: queue, surfaceHash: job.identity.surfaceHash },
    update: { taskQueue: queue, surfaceHash: job.identity.surfaceHash },
  });
  await api.transitionWorkerDeployment(job.jobId, 'READY', 'ACTIVATED', {}, owner);
  await api.transitionWorkerDeployment(job.jobId, 'ACTIVATED', 'DRAINING', {}, owner);
  return queue;
}
async function banks(owner: string) {
  const app = appFor('banks');
  const a = await api.enqueueWorkerDeployment(identity(app, 'first'));
  const old = plan('bank-a');
  const queue = await activate(a, old, owner);
  const done = { candidateHealthy: true, priorDisposition: 'RETAINED_LEGACY' };
  await api.transitionWorkerDeployment(a.jobId, 'DRAINING', 'SUCCEEDED', done, owner);
  assert.equal(
    await prisma.toolSideEffect.count({
      where: { externalId: app, operationType: 'WORKER_DEPLOYMENT_RESERVATION', status: 'ACTIVE' },
    }),
    8
  );
  const b = await api.enqueueWorkerDeployment(identity(app, 'second'));
  const prior = { taskQueue: queue, surfaceHash: a.identity.surfaceHash };
  await assert.rejects(
    api.prepareWorkerDeployment(b.jobId, { ...old, priorPointer: prior }, owner),
    /active/
  );
  await activate(b, plan('bank-b', prior), owner);
  const machines = old.candidateMachineIds.map((machineId) => ({
    machineId,
    previousJobId: a.jobId,
    instanceId: 'retired-native-version',
    configSHA256: 'd'.repeat(64),
    retiredQueue: queue,
    certificateRef: `agent-queue-admission:${queue}`,
  }));
  await assert.rejects(api.releaseRetiredWorkerMachines(b.jobId, machines, owner), /unqualified/);
  await prisma.toolSideEffect.create({
    data: {
      operationKey: queueAdmissionKey(queue),
      operationType: 'AGENT_QUEUE_ADMISSION',
      status: 'RETIRED',
      externalId: app,
      request: {
        version: 1,
        queue,
        owner: b.jobId,
        incarnation: 'fixture-incarnation',
        phase: 'RETIRED',
        legacyCoverage: 'QUALIFIED',
        legacyCertificate: {
          producerTransition: 'fixture-native-producer-fence',
          cohortManifest: 'fixture-exact-chain-census',
          unresolved: 0,
        },
      },
    },
  });
  await api.releaseRetiredWorkerMachines(b.jobId, machines, owner);
  await api.releaseRetiredWorkerMachines(b.jobId, machines, owner); // lost native release ACK
  await assert.rejects(
    api.releaseRetiredWorkerMachines(b.jobId, [{ ...machines[0], instanceId: 'different' }], owner),
    /ownership/
  );
  await api.transitionWorkerDeployment(
    b.jobId,
    'DRAINING',
    'SUCCEEDED',
    { candidateHealthy: true, priorDisposition: 'RETIRED' },
    owner
  );
  assert.equal(
    await prisma.toolSideEffect.count({
      where: {
        externalId: app,
        operationType: 'WORKER_DEPLOYMENT_RESERVATION',
        status: 'RELEASED',
      },
    }),
    8
  );
  assert.equal(
    await prisma.toolSideEffect.count({
      where: { externalId: app, operationType: 'WORKER_DEPLOYMENT_RESERVATION', status: 'ACTIVE' },
    }),
    8
  );
  await assert.rejects(
    api.transitionWorkerDeployment(b.jobId, 'SUCCEEDED', 'ABORTED', {}, owner),
    /transition/
  );
  assert.equal(await api.readWorkerDeploymentHead(app), null);
}
async function abort(owner: string) {
  const app = appFor('abort');
  const a = await api.enqueueWorkerDeployment(identity(app, 'first'));
  const b = await api.enqueueWorkerDeployment(identity(app, 'second'));
  await api.abortWorkerDeployment(a.jobId, 'operator cancels untouched queued intent', owner);
  assert.equal((await api.readWorkerDeployment(a.jobId)).stage, 'ABORTED');
  assert.equal((await api.readWorkerDeploymentHead(app))?.jobId, b.jobId);
  await api.prepareWorkerDeployment(b.jobId, plan('abort-b'), owner);
}
async function parentRecovery() {
  const app = appFor('parent');
  const a = await api.enqueueWorkerDeployment(identity(app, 'first'));
  const b = await api.enqueueWorkerDeployment(identity(app, 'second'));
  const priorOwner = await acquireWorkflowDeploymentLease();
  const priorPlan = plan('parent-resume');
  await api.prepareWorkerDeployment(a.jobId, priorPlan, priorOwner.ownerId);
  await priorOwner.release();
  const folder = await mkdtemp(path.join(tmpdir(), 'worker-queue-parent-'));
  const fixture = path.join(folder, 'child.ts');
  const provider = path.resolve(__dirname, '../../providers/workerDeploymentQueue.ts');
  const database = path.resolve(__dirname, '../../providers/database.ts');
  const code = `const q = require(${JSON.stringify(provider)}); const {prisma} = require(${JSON.stringify(database)}); const fs=require('node:fs'); async function main(){ const id=process.env.WORKER_DEPLOYMENT_JOB_ID; const owner=process.env.WORKER_DEPLOYMENT_OWNER_ID; const job=await q.readWorkerDeployment(id); if(job.ownerId!==owner)throw new Error('durable owner not claimed before child'); const marker=${JSON.stringify(folder)}+'/'+id; fs.appendFileSync(marker,'invoked\\n'); if(!fs.existsSync(marker+'.wait')){fs.writeFileSync(marker+'.wait',''); process.exitCode=75; return;} if(job.stage==='QUEUED'){const ids=Array.from({length:8},(_,i)=>id.slice(0,8)+'-'+i); await q.prepareWorkerDeployment(id,{priorPointer:await prisma.agentQueuePointer.findUnique({where:{id:'singleton'},select:{taskQueue:true,surfaceHash:true}}),candidateMachineIds:ids,evidence:{candidateRecords:ids.map(id=>({id,instanceId:'v1',configSHA256:'d'.repeat(64)})),previousRecords:[]}},owner);} await q.transitionWorkerDeployment(id,'PREPARING','READY',{},owner); const queue=q.workerDeploymentQueueName(id,job.identity.surfaceHash); await prisma.agentQueuePointer.upsert({where:{id:'singleton'},create:{id:'singleton',taskQueue:queue,surfaceHash:job.identity.surfaceHash},update:{taskQueue:queue,surfaceHash:job.identity.surfaceHash}}); await q.transitionWorkerDeployment(id,'READY','ACTIVATED',{},owner); await q.transitionWorkerDeployment(id,'ACTIVATED','DRAINING',{},owner); await q.transitionWorkerDeployment(id,'DRAINING','SUCCEEDED',{candidateHealthy:true,priorDisposition:'RETAINED_LEGACY'},owner); } main().catch(e=>{process.stderr.write(String(e));process.exitCode=1}).finally(()=>prisma.$disconnect());`;
  try {
    await writeFile(fixture, code);
    const cli = path.resolve(__dirname, '../../../scripts/worker-deployment-queue.ts');
    const [interpreter, fixtureArgs] = typeScriptProcess([fixture]);
    const abortWaiting = await execTypeScript(
      [cli, 'run', '--allow-abort', '--job-id', b.jobId, '--', 'must-not-abort-predecessor'],
      { timeout: 5000 }
    );
    assert.equal(JSON.parse(abortWaiting.stdout.trim()).reason, 'ABORT_FIFO_PREDECESSOR');
    const result = await execTypeScript(
      [cli, 'run', '--job-id', b.jobId, '--', interpreter, ...fixtureArgs],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    );
    const events = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert(events.some((event) => event.recoveringPredecessor === true));
    assert(events.some((event) => event.reason === 'CHILD_WAIT'));
    assert.equal(events.at(-1).stage, 'SUCCEEDED');
    assert.equal((await api.readWorkerDeployment(a.jobId)).failure, null);
    assert.equal((await api.readWorkerDeployment(b.jobId)).failure, null);
    assert.equal(
      (await readFile(path.join(folder, a.jobId), 'utf8')).split('invoked').length - 1,
      2
    );
    await execTypeScript([cli, 'run', '--job-id', b.jobId, '--', 'nonexistent-must-not-start'], {
      timeout: 5000,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
async function preparedAbort(owner: string) {
  const app = appFor('abandon');
  const a = await api.enqueueWorkerDeployment(identity(app, 'first'));
  const p = plan('abandon');
  await api.prepareWorkerDeployment(a.jobId, p, owner);
  const records = p.evidence.candidateRecords;
  const proof = {
    machineRecords: records,
    reason: 'explicit unpublished candidate quiesced by fixture',
  };
  await assert.rejects(api.abortPreparedWorkerDeployment(a.jobId, proof, owner), /unqualified/);
  const queue = api.workerDeploymentQueueName(a.jobId, a.identity.surfaceHash);
  await prisma.toolSideEffect.create({
    data: {
      operationKey: queueAdmissionKey(queue),
      operationType: 'AGENT_QUEUE_ADMISSION',
      externalId: app,
      status: 'RETIRED',
      request: {
        version: 1,
        queue,
        owner: a.jobId,
        incarnation: 'fixture-incarnation',
        phase: 'RETIRED',
        legacyCoverage: 'QUALIFIED',
        legacyCertificate: {
          producerTransition: 'fixture-fresh-producer-fence',
          cohortManifest: 'fixture-zero-accepted-chain-census',
          unresolved: 0,
        },
      },
    },
  });
  await api.abortPreparedWorkerDeployment(a.jobId, proof, owner);
  await api.abortPreparedWorkerDeployment(a.jobId, proof, owner);
  assert.equal((await api.readWorkerDeployment(a.jobId)).stage, 'ABORTED');
  assert.equal(
    await prisma.toolSideEffect.count({
      where: {
        externalId: app,
        operationType: 'WORKER_DEPLOYMENT_RESERVATION',
        status: 'RELEASED',
      },
    }),
    8
  );
  const next = await api.enqueueWorkerDeployment(identity(app, 'fixed'));
  assert.equal((await api.readWorkerDeploymentHead(app))?.jobId, next.jobId);
}
async function waitForOutput(stream: Readable, expected: string) {
  let output = '';
  for await (const [chunk] of on(stream, 'data', { signal: AbortSignal.timeout(5000) })) {
    output += String(chunk);
    if (output.includes(expected)) return;
  }
  assert.fail('local child output ended before its owned readiness event');
}
async function processSafety() {
  const folder = await mkdtemp(path.join(tmpdir(), 'worker-queue-signal-'));
  const marker = path.join(folder, 'child-pid');
  const cli = path.resolve(__dirname, '../../../scripts/worker-deployment-queue.ts');
  const a = await api.enqueueWorkerDeployment(identity(appFor('signal'), 'first'));
  const hold = await acquireWorkflowDeploymentLease();
  try {
    const idle = await execTypeScript(
      [cli, 'run', '--if-idle', '--job-id', a.jobId, '--', 'must-not-spawn'],
      { timeout: 5000 }
    );
    assert.equal(JSON.parse(idle.stdout.trim()).reason, 'GLOBAL_LEASE_BUSY');
    const waiting = spawnTypeScript([
      cli,
      'run',
      '--job-id',
      a.jobId,
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));console.log('CHILD_READY');setInterval(()=>{},1000)`,
    ]);
    waiting.stderr.resume();
    const ended = new Promise<number | null>((resolve) => waiting.once('close', resolve));
    await waitForOutput(waiting.stdout, 'GLOBAL_LEASE_BUSY');
    waiting.kill('SIGTERM');
    assert.equal(await ended, 143);
    assert.equal(existsSync(marker), false);
    await api.recordWorkerDeploymentFailure(a.jobId, 'fixture native attempt failed', hold.ownerId);
  } finally {
    await hold.release();
  }
  try {
    const deferred = await execTypeScript(
      [cli, 'run', '--if-idle', '--job-id', a.jobId, '--', 'must-not-spawn'],
      { timeout: 5000 }
    );
    assert.equal(JSON.parse(deferred.stdout.trim()).reason, 'FAILED_ATTEMPT_CADENCE');
    assert.equal(existsSync(marker), false);
    const running = spawnTypeScript([
      cli,
      'run',
      '--job-id',
      a.jobId,
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));console.log('CHILD_READY');setInterval(()=>{},1000)`,
    ]);
    running.stdout.resume();
    running.stderr.resume();
    const ended = new Promise<number | null>((resolve) => running.once('close', resolve));
    await waitForOutput(running.stdout, 'CHILD_READY');
    const ownedPid = Number(await readFile(marker, 'utf8'));
    const intruder = randomUUID();
    await prisma.toolSideEffect.update({
      where: { operationKey: 'deployment:temporal-workflow-cutover' },
      data: { externalId: intruder },
    });
    assert.equal(await ended, 1);
    assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
    assert.equal(
      await prisma.toolSideEffect.count({
        where: {
          operationType: 'WORKER_DEPLOYMENT_EVENT',
          externalId: a.jobId,
          status: 'LEASE_LOST',
        },
      }),
      1
    );
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: 'deployment:temporal-workflow-cutover', externalId: intruder },
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
async function main() {
  await test('production qualifier reads durable terminal originals and live pointer without mutations', () =>
    qualificationCases({ api, prisma, appFor, identity }));
  let lease = await acquireWorkflowDeploymentLease({ leaseMs: 60000, heartbeatMs: 59000 });
  try {
    await test('concurrent enqueue/reservation FIFO, retained failure, same job recovery', () =>
      fifo(lease.ownerId));
    await test('all eight reservations rollback together, malformed bank rejected', () =>
      atomic(lease.ownerId));
    await test('two managed banks retain ACTIVE custody and release only certified old bank idempotently', () =>
      banks(lease.ownerId));
    await test('explicit empty retention preserves ordinary legacy and managed full deployment', () =>
      emptyRetentionCases({
        api,
        prisma,
        owner: lease.ownerId,
        app: appFor('empty-retention'),
        identity,
      }));
    await test('route mismatch retention is atomic, owned, non-destructive and reported honestly', async () => {
      const pointer = await prisma.agentQueuePointer.findUniqueOrThrow({
        where: { id: 'singleton' },
      });
      try {
        await retainedRouteMismatchCases({
          api,
          prisma,
          owner: lease.ownerId,
          app: appFor('retention'),
          identity,
        });
      } finally {
        await prisma.agentQueuePointer.update({
          where: { id: 'singleton' },
          data: {
            taskQueue: pointer.taskQueue,
            surfaceHash: pointer.surfaceHash,
            updatedBy: pointer.updatedBy,
          },
        });
      }
    });
    await test('explicit QUEUED-only abort unblocks FIFO, prepared abort stays fenced', () =>
      abort(lease.ownerId));
    await test('unpublished prepared abort requires real target tombstone and releases exact bank idempotently', () =>
      preparedAbort(lease.ownerId));
    await test('unstarted queued releases coalesce into a proven git descendant only', () =>
      coalesceCases({ api, owner: lease.ownerId, appFor, identity, plan }));
    await lease.release();
    await test('a connection lost inside the read-only ownership assertion is retried, not fatal', async () => {
      // A fresh lease keeps its 59 s heartbeat far from the held lease lock.
      const own = await acquireWorkflowDeploymentLease({ leaseMs: 60000, heartbeatMs: 59000 });
      try {
        await transientAssertionCase({ api, owner: own.ownerId, appFor, identity, plan });
      } finally {
        await own.release();
      }
    });
    await test(
      'parent idle admission, interrupted wait and actual owned child lease loss',
      processSafety
    );
    await test(
      'parent resumes FIFO predecessors and exit75 wait without failure or duplicate completed execution',
      parentRecovery
    );
    await test('queue CLI coalesces into proven descendants and never rolls the live release back', () =>
      coalesceCliCases({ api, appFor, identity }));
    await test('an older release controller leaves a coalesced newer head to its own run', () =>
      newerReleaseControllerCases({ api, appFor, identity }));
    lease = await acquireWorkflowDeploymentLease({ leaseMs: 60000, heartbeatMs: 59000 });
    await test('expired and replaced global owners cannot mutate', async () => {
      const app = appFor('expiry');
      const a = await api.enqueueWorkerDeployment(identity(app, 'expiry'));
      await prisma.toolSideEffect.update({
        where: { operationKey: 'deployment:temporal-workflow-cutover' },
        data: { updatedAt: new Date(Date.now() - 120000) },
      });
      await assert.rejects(
        api.prepareWorkerDeployment(a.jobId, plan('expiry'), lease.ownerId),
        /lease/
      );
      const replacement = await acquireWorkflowDeploymentLease({
        leaseMs: 60000,
        heartbeatMs: 59000,
      });
      try {
        await assert.rejects(api.assertWorkerDeploymentOwned(a.jobId, lease.ownerId), /lease/);
        await api.assertWorkerDeploymentOwned(a.jobId, replacement.ownerId);
      } finally {
        await replacement.release();
      }
    });
  } finally {
    await lease.release();
    await prisma.toolSideEffect.deleteMany({
      where: {
        operationType: {
          in: [
            'WORKER_DEPLOYMENT_JOB',
            'WORKER_DEPLOYMENT_RESERVATION',
            'AGENT_QUEUE_ADMISSION',
            'WORKER_DEPLOYMENT_ANCESTRY',
          ],
        },
        externalId: { in: apps },
      },
    });
  }
}
async function isolated() {
  const url = process.env.DATABASE_URL;
  assert.equal(
    nonLocalDatabaseReason(url),
    null,
    'explicit local test database required before any query'
  );
  const schema = `worker_deployment_${randomUUID().replaceAll('-', '')}`;
  const scoped = new URL(url!);
  scoped.searchParams.set('schema', schema);
  const admin = new PrismaClient({ datasources: { db: { url } } });
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."ToolSideEffect" ("id" TEXT PRIMARY KEY, "operationKey" TEXT NOT NULL UNIQUE, "operationType" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'STARTED', "externalId" TEXT, "request" JSONB, "response" JSONB, "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL)`
    );
    await admin.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."AgentQueuePointer" ("id" TEXT PRIMARY KEY DEFAULT 'singleton', "taskQueue" TEXT NOT NULL, "surfaceHash" TEXT NOT NULL, "updatedBy" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL)`
    );
    for (const column of ['operationType', 'status', 'externalId'])
      await admin.$executeRawUnsafe(
        `CREATE INDEX "ToolSideEffect_${column}_idx" ON "${schema}"."ToolSideEffect" ("${column}")`
      );
    process.env.DATABASE_URL = scoped.toString();
    process.env.DIRECT_URL = scoped.toString();
    ({ prisma } = await import('../../providers/database'));
    api = await import('../../providers/workerDeploymentQueue');
    ({ acquireWorkflowDeploymentLease } = await import('../../providers/workflowDeploymentLease'));
    ({ queueAdmissionKey } = await import('../../providers/workflowQueueAdmission'));
    ({ test, finish } = (await import('./trace-archive-test-utils')).createTestHarness(
      'worker deployment durable queue isolated Postgres'
    ));
    await prisma.agentQueuePointer.create({ data: { id: 'singleton', ...priorFixture } });
    await main();
  } finally {
    if (prisma) await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  }
  finish();
}
isolated().catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exitCode = 1;
});
