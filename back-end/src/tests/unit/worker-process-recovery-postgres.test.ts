/** Actual persisted deployment custody; native process boundaries remain injected. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { createTestHarness } from './trace-archive-test-utils';
import {
  canonicalWorkerJSON,
  workerSHA256,
  workerPlanIdentity,
  type WorkerProcessPlan,
  type WorkerProcessTransport,
} from '../../providers/workerProcessDeployment';

const { test, finish } = createTestHarness('existing worker process recovery real Postgres');
async function main() {
  const url = process.env.DATABASE_URL;
  assert.equal(nonLocalDatabaseReason(url), null, 'explicit local test database required');
  const schema = `worker_recovery_${randomUUID().replaceAll('-', '')}`;
  const isolated = new URL(url!);
  isolated.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasources: { db: { url: isolated.toString() } } });
  // The engine's one-time TLS setenv must finish before another client reads process.env.
  await db.$connect();
  const { prisma } = await import('../../providers/database');
  const {
    registerExistingWorkerProcesses,
    recoverExistingWorkerProcesses,
    requireBackendWorkerRecovery,
    recoverConfiguredWorkerProcesses,
    WORKER_PROCESS_DESIRED_KEY,
  } = await import('../../providers/workerProcessRecovery');
  const originalTransaction = prisma.$transaction;
  const originalDelegate = prisma.toolSideEffect;
  const guardedKeys = [
    'RENDER_INSTANCE_ID',
    'RENDER_GIT_COMMIT',
    'RENDER',
    'NODE_ENV',
    'RENDER_SERVICE_ID',
    'DATABASE_URL',
    'BACKEND_API_KEY',
  ] as const;
  const originalEnvironment = Object.fromEntries(guardedKeys.map((key) => [key, process.env[key]]));
  const source = 'a'.repeat(40),
    digest = 'b'.repeat(64);
  const config = {
    image: 'old',
    env: {
      TEMPORAL_WORKER_BUILD_ID: 'old',
      TEMPORAL_WORKER_SURFACE_HASH: 'old',
      MIN_MACHINES: '8',
    },
  };
  const plan: WorkerProcessPlan = {
    version: 1,
    peopleCredentialBrokerOrigin: 'https://navi-j9a9.onrender.com',
    app: 'owned-production-app',
    attempt: 'pg-attempt',
    controlPlane: {
      serviceId: 'srv-local-fixture',
      backendOrigin: 'https://navi-j9a9.onrender.com',
      databaseHost: 'qualified.remote.test',
      databaseName: 'production',
    },
    previousQueue: 'navi-agent-tasks@old',
    healthPort: 0,
    sdkMetricsPort: 0,
    hosts: Array.from({ length: 8 }, (_, n) => ({
      id: n.toString(16).padStart(14, '0'),
      configSHA256: workerSHA256(canonicalWorkerJSON(config)),
      imageDigest: `sha256:${digest}`,
    })),
    limits: {
      maxAddressBytes: 1024 ** 3,
      aggregateMemoryBytes: 1024 ** 3,
      minFreeAfterMaxAddressBytes: 256 * 1024 ** 2,
      memoryController: 'v1-memory',
    },
    artifact: {
      sourceCommit: source,
      buildId: source,
      surfaceHash: 'c'.repeat(12),
      deploymentToken: 'pg-attempt',
      namespace: 'local-pg-test',
      baseTaskQueue: 'navi-agent-tasks',
      validationTaskQueue: 'navi-agent-candidate-pg-attempt',
      bundleBase64: Buffer.from('source').toString('base64'),
      bundleSHA256: workerSHA256('source'),
      bootstrapSource: '# fixture',
      bootstrapSHA256: workerSHA256('# fixture'),
      manifest: {
        version: 1,
        sourceCommit: source,
        requirementsSHA256: digest,
        installedDistributionsSHA256: digest,
        pythonSHA256: digest,
        files: ['agents/worker.py', 'agents/requirements.txt'].map((path) => ({
          path,
          sha256: digest,
          mode: 0o644,
          size: 1,
        })),
      },
    },
  };
  const lease = {
    ownerId: 'local-external-lease-fixture',
    assertOwned: async () => {},
    release: async () => {},
  };
  let ensureCalls = 0,
    nativeCalls = 0;
  const bootId = randomUUID();
  const transport: WorkerProcessTransport = {
    async listMachines() {
      return plan.hosts.map((host) => ({
        id: host.id,
        instance_id: 'old-version',
        state: 'started',
        config,
      }));
    },
    async getMachine(_app, id) {
      nativeCalls++;
      return {
        id,
        version: 'old-version',
        state: 'started',
        config,
        image_ref: { digest: `sha256:${digest}` },
      };
    },
    async readFacts(_app, id) {
      return {
        machineId: id,
        machineVersion: 'old-version',
        bootId,
        primary: { pid: 10, birthTicks: '10', buildId: 'old', healthy: true, phase: 'running' },
      };
    },
    async execBootstrap(_app, id, _source, envelope) {
      if (envelope.action === 'ensure') ensureCalls++;
      return {
        version: 1,
        app: plan.app,
        machineId: id,
        machineVersion: 'old-version',
        bootId,
        sourceCommit: source,
        bundleSHA256: plan.artifact.bundleSHA256,
        buildId: source,
        deploymentToken: plan.attempt,
        phase: 'STANDBY',
        supervisorPid: 20,
        supervisorBirthTicks: '20',
        workerPid: 30,
        workerBirthTicks: '30',
        hostname: id,
        aggregateMemoryBytes: 1024 ** 3,
        health: { healthy: true, phase: 'standby', build_id: source },
      };
    },
  };
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."ToolSideEffect" (
      "id" TEXT PRIMARY KEY, "operationKey" TEXT NOT NULL UNIQUE, "operationType" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'STARTED', "externalId" TEXT, "request" JSONB, "response" JSONB, "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL)`);
    prisma.$transaction = db.$transaction.bind(db) as typeof prisma.$transaction;
    Object.defineProperty(prisma, 'toolSideEffect', {
      configurable: true,
      value: db.toolSideEffect,
    });
    await test('concurrent registration commits one complete immutable source intent', async () => {
      const ids = await Promise.all([
        registerExistingWorkerProcesses(plan, lease),
        registerExistingWorkerProcesses(plan, lease),
      ]);
      assert.equal(ids[0], workerPlanIdentity(plan));
      assert.equal(ids[0], ids[1]);
      assert.equal(await db.toolSideEffect.count(), 1);
      const row = await db.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
      });
      assert.deepEqual((row.request as { plan: unknown }).plan, plan);
      const other = structuredClone(plan);
      other.healthPort = 18080;
      await assert.rejects(
        registerExistingWorkerProcesses(other, lease),
        /explicit reconciliation/
      );
      assert.deepEqual(
        (
          await db.toolSideEffect.findUniqueOrThrow({
            where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
          })
        ).request,
        row.request
      );
    });
    await test('new recovery invocation reads committed source and records eight exact native observations', async () => {
      const rows = await recoverExistingWorkerProcesses({
        transport,
        key: 'local-fixture-only',
        lease,
        expectedIdentity: workerPlanIdentity(plan),
      });
      assert.equal(rows.length, 8);
      assert.equal(ensureCalls, 0);
      assert.equal(nativeCalls, 8);
      const row = await db.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
      });
      assert.equal((row.response as { identity: string }).identity, workerPlanIdentity(plan));
      await assert.rejects(requireBackendWorkerRecovery(plan), /backend recovery owner/);
    });
    await test('backend proof survives backend revision and CLI observation while rejecting stale or invalid provenance', async () => {
      process.env.RENDER_INSTANCE_ID = 'LOCAL-MOCK-INSTANCE-NOT-PRODUCTION';
      process.env.RENDER_GIT_COMMIT = 'd'.repeat(40);
      process.env.RENDER = 'true';
      process.env.NODE_ENV = 'production';
      process.env.RENDER_SERVICE_ID = plan.controlPlane.serviceId;
      process.env.DATABASE_URL = 'postgresql://fixture:fixture@qualified.remote.test/production';
      process.env.BACKEND_API_KEY = 'LOCAL-FIXTURE-NOT-PRODUCTION';
      await recoverExistingWorkerProcesses({ transport, key: 'local-fixture-only', lease });
      await assert.rejects(requireBackendWorkerRecovery(plan), /backend recovery owner/);
      await recoverConfiguredWorkerProcesses({ transport });
      await requireBackendWorkerRecovery(plan);
      const published = await db.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
      });
      assert.equal(
        (published.response as { backendRecovery: { backendSource: string } }).backendRecovery
          .backendSource,
        'd'.repeat(40)
      );
      await assert.rejects(
        requireBackendWorkerRecovery(plan, 'RUNNING'),
        /All eight exact runtime processes/
      );
      delete process.env.RENDER_INSTANCE_ID;
      delete process.env.RENDER_GIT_COMMIT;
      await recoverExistingWorkerProcesses({ transport, key: 'local-fixture-only', lease });
      await requireBackendWorkerRecovery(plan);
      const row = await db.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
      });
      const response = row.response as {
        backendRecovery: { backendSource: string; observedAt: string };
      };
      response.backendRecovery.backendSource = 'invalid';
      await db.toolSideEffect.update({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
        data: { response },
      });
      await assert.rejects(requireBackendWorkerRecovery(plan), /backend recovery owner/);
      response.backendRecovery.backendSource = source;
      response.backendRecovery.observedAt = new Date(Date.now() - 180_000).toISOString();
      await db.toolSideEffect.update({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
        data: { response },
      });
      await assert.rejects(requireBackendWorkerRecovery(plan), /backend recovery owner/);
    });
    await test('withdrawn durable custody denies all recovery IO without altering retained source', async () => {
      await db.toolSideEffect.update({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
        data: { status: 'HELD' },
      });
      const before = nativeCalls;
      await assert.rejects(
        recoverExistingWorkerProcesses({ transport, key: 'local-fixture-only', lease }),
        /not active/
      );
      assert.equal(nativeCalls, before);
      assert.equal(
        await db.toolSideEffect.count({ where: { operationKey: WORKER_PROCESS_DESIRED_KEY } }),
        1
      );
    });
  } finally {
    prisma.$transaction = originalTransaction;
    Object.defineProperty(prisma, 'toolSideEffect', {
      configurable: true,
      value: originalDelegate,
    });
    for (const key of guardedKeys) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await prisma.$disconnect();
  }
  finish();
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
