import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkerProcessTransport } from '../../providers/workerProcessTransport';
import {
  canonicalWorkerJSON,
  reconcileWorkerProcesses,
  requireEightWorkerProcesses,
  workerSHA256,
  type ProcessReceipt,
  type WorkerProcessPlan,
  type WorkerProcessTransport,
} from '../../providers/workerProcessDeployment';

export const config = {
  env: {
    TEMPORAL_WORKER_BUILD_ID: 'old',
    TEMPORAL_WORKER_SURFACE_HASH: 'old-generation',
    MIN_MACHINES: '8',
  },
  image: 'old',
};
export function fixture() {
  const source = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const plan: WorkerProcessPlan = {
    version: 1,
    app: 'owned-production-app',
    attempt: 'qualified-attempt-1',
    controlPlane: {
      serviceId: 'srv-local-fixture',
      backendOrigin: 'https://navi-j9a9.onrender.com',
      databaseHost: 'qualified.remote.test',
      databaseName: 'production',
    },
    peopleCredentialBrokerOrigin: 'https://navi-j9a9.onrender.com',
    previousQueue: 'navi-agent-tasks@old-generation',
    hosts: Array.from({ length: 8 }, (_, index) => ({
      id: index.toString(16).padStart(14, '0'),
      configSHA256: workerSHA256(canonicalWorkerJSON(config)),
      imageDigest: `sha256:${digest}`,
    })),
    healthPort: 18080,
    sdkMetricsPort: 19090,
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
      deploymentToken: 'qualified-attempt-1',
      namespace: 'native-test',
      baseTaskQueue: 'navi-agent-tasks',
      validationTaskQueue: 'navi-agent-candidate-qualified-attempt-1',
      bundleBase64: Buffer.from('source-fixture').toString('base64'),
      bundleSHA256: workerSHA256('source-fixture'),
      bootstrapSource: '# actual source substituted by packaging owner',
      bootstrapSHA256: workerSHA256('# actual source substituted by packaging owner'),
      manifest: {
        version: 1,
        sourceCommit: source,
        requirementsSHA256: digest,
        installedDistributionsSHA256: digest,
        pythonSHA256: digest,
        files: ['agents/worker.py', 'agents/requirements.txt'].map((path) => ({
          path,
          sha256: digest,
          size: 1,
          mode: 0o644,
        })),
      },
    },
  };
  const calls: { id: string; action: unknown; hasBundle: boolean }[] = [];
  let phase: ProcessReceipt['phase'] = 'STANDBY';
  let wrongConfig = false;
  let wrongBoot = false;
  const bootId = randomUUID();
  const transport: WorkerProcessTransport = {
    async listMachines() {
      return Promise.all(plan.hosts.map((host) => transport.getMachine(plan.app, host.id)));
    },
    async getMachine(_app, id) {
      return {
        id,
        state: 'started',
        version: 'existing-instance',
        image_ref: { digest: `sha256:${digest}` },
        config: wrongConfig ? { changed: true } : config,
      };
    },
    async readFacts(_app, id) {
      return {
        machineId: id,
        machineVersion: 'existing-instance',
        bootId,
        primary: { pid: 10, birthTicks: '1', buildId: 'old', healthy: true, phase: 'running' },
      };
    },
    async execBootstrap(_app, id, _source, envelope) {
      calls.push({ id, action: envelope.action, hasBundle: !!envelope.bundleBase64 });
      return {
        version: 1,
        app: plan.app,
        machineId: id,
        machineVersion: 'existing-instance',
        bootId: wrongBoot ? randomUUID() : bootId,
        sourceCommit: source,
        bundleSHA256: plan.artifact.bundleSHA256,
        buildId: source,
        deploymentToken: plan.attempt,
        phase: envelope.action === 'ensure' ? 'BOOTING' : phase,
        supervisorPid: 20,
        supervisorBirthTicks: '100',
        workerPid: 30,
        workerBirthTicks: '101',
        hostname: id,
        aggregateMemoryBytes: 1024 ** 3,
        health: { healthy: true, phase: 'standby', build_id: source },
      };
    },
  };
  return {
    plan,
    calls,
    transport,
    setPhase: (value: ProcessReceipt['phase']) => (phase = value),
    changeConfig: () => (wrongConfig = true),
    changeBoot: () => (wrongBoot = true),
  };
}

function poolFixture() {
  const f = fixture();
  const pool = f.plan.hosts.map((host) => ({
    id: host.id,
    name: 'immutable-old-generation-name',
    instance_id: 'existing-instance',
    state: 'started',
    config: structuredClone(config),
  }));
  let facts = 0;
  let gets = 0;
  const readFacts = f.transport.readFacts;
  const getMachine = f.transport.getMachine;
  const transport = {
    ...f.transport,
    listMachines: async () => structuredClone(pool),
    getMachine: async (app: string, id: string) => {
      gets++;
      return getMachine(app, id);
    },
    readFacts: async (app: string, id: string) => {
      facts++;
      return readFacts(app, id);
    },
  };
  return {
    ...f,
    pool,
    transport,
    counts: () => ({ facts, gets }),
    resetCounts: () => {
      facts = 0;
      gets = 0;
    },
  };
}

export async function registerOldPoolCohortTests(
  test: (name: string, fn: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  await test('the actual nine-member old surface denies every process action before host facts', async () => {
    const f = fixture();
    f.setPhase('MISSING');
    const nativeConfig = {
      ...config,
      env: { ...config.env, MIN_MACHINES: '8', TEMPORAL_WORKER_SURFACE_HASH: 'old-generation' },
    };
    const pool = f.plan.hosts.map((host) => ({
      id: host.id,
      state: 'started',
      instance_id: 'existing-instance',
      config: nativeConfig,
    }));
    pool.push({
      id: '8940e0f6e0d3d8',
      state: 'stopped',
      instance_id: 'old-spare',
      config: nativeConfig,
    });
    for (const host of f.plan.hosts)
      host.configSHA256 = workerSHA256(canonicalWorkerJSON(nativeConfig));
    let facts = 0;
    const readFacts = f.transport.readFacts;
    const getMachine = f.transport.getMachine;
    const transport = {
      ...f.transport,
      listMachines: async () => structuredClone(pool),
      getMachine: async (app: string, id: string) => ({
        ...(await getMachine(app, id)),
        config: nativeConfig,
      }),
      readFacts: async (app: string, id: string) => {
        facts++;
        return readFacts(app, id);
      },
    };
    const before = structuredClone(pool);
    const rows = await reconcileWorkerProcesses(
      f.plan,
      transport,
      'private-test-key',
      async () => {}
    );
    assert.equal(facts, 0, 'unsafe old pool reached native facts');
    assert.equal(f.calls.length, 0, 'unsafe old pool reached status/ensure');
    assert.equal(rows.length, 8);
    assert(rows.every((row) => row.phase === 'UNKNOWN'));
    assert.deepEqual(pool, before);
  });
  await test('only the complete exact old cohort qualifies, and foreign surfaces remain isolated', async () => {
    const f = poolFixture();
    f.pool.push({
      ...structuredClone(f.pool[0]),
      id: '8940e0f6e0d3d8',
      state: 'stopped',
      config: {
        ...config,
        env: {
          ...config.env,
          TEMPORAL_WORKER_SURFACE_HASH: 'foreign-generation',
          MIN_MACHINES: '2',
        },
      },
    });
    const before = structuredClone(f.pool);
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert.equal(requireEightWorkerProcesses(f.plan, rows, 'STANDBY').length, 8);
    assert.equal(f.counts().facts, 8);
    assert.deepEqual(f.pool, before);
  });
  await test('low or unknown native floors and malformed cohorts deny before any exact host action', async () => {
    const mutations: ((f: ReturnType<typeof poolFixture>) => void)[] = [
      (f) => {
        f.pool[0].config.env.MIN_MACHINES = '7';
      },
      (f) => {
        delete (f.pool[0].config.env as Partial<typeof config.env>).MIN_MACHINES;
      },
      (f) => {
        f.pool[0].config.env.MIN_MACHINES = '8garbage';
      },
      (f) => {
        f.pool[0].config.env.MIN_MACHINES = '8.5';
      },
      (f) => {
        f.pool.pop();
      },
      (f) => {
        f.pool.push(structuredClone(f.pool[0]));
      },
      (f) => {
        f.pool[0].state = 'stopped';
      },
      (f) => {
        f.pool[0].config.env.TEMPORAL_WORKER_SURFACE_HASH = '';
      },
      (f) => {
        f.transport.listMachines = async () => {
          throw new Error('native list unavailable');
        };
      },
      (f) => {
        f.transport.listMachines = async () => null as never;
      },
      (f) => {
        f.transport.listMachines = async () => [null] as never;
      },
      (f) => {
        f.transport.listMachines = async () =>
          [{ id: '8940e0f6e0d3d8', config: { env: [] } }] as never;
      },
    ];
    for (const mutate of mutations) {
      const f = poolFixture();
      mutate(f);
      const rows = await reconcileWorkerProcesses(
        f.plan,
        f.transport,
        'private-test-key',
        async () => {}
      );
      assert.deepEqual(f.counts(), { facts: 0, gets: 0 });
      assert.equal(f.calls.length, 0);
      assert.equal(rows.length, 8);
      assert(rows.every((row) => row.phase === 'UNKNOWN'));
    }
  });
  await test('native list floor cannot relax the pinned original config before the exact host read', async () => {
    for (const [captured, listed] of [
      ['2', '8'],
      ['7', '7'],
    ]) {
      const f = poolFixture();
      const unsafe = { ...config, env: { ...config.env, MIN_MACHINES: captured } };
      f.pool[0].config.env.MIN_MACHINES = listed;
      f.plan.hosts[0].configSHA256 = workerSHA256(canonicalWorkerJSON(unsafe));
      const getMachine = f.transport.getMachine;
      f.transport.getMachine = async (app, id) => {
        const host = await getMachine(app, id);
        return id === f.plan.hosts[0].id ? { ...host, config: unsafe } : host;
      };
      const rows = await reconcileWorkerProcesses(
        f.plan,
        f.transport,
        'private-test-key',
        async () => {}
      );
      assert(rows.every((row) => row.phase === 'UNKNOWN'));
      assert.equal(f.counts().facts, 0);
      assert.equal(f.calls.length, 0);
    }
  });
  await test('a changed old pool is rechecked instead of trusting a previous ready observation', async () => {
    const f = poolFixture();
    const first = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert.equal(requireEightWorkerProcesses(f.plan, first, 'STANDBY').length, 8);
    f.pool.push({
      ...structuredClone(f.pool[0]),
      id: '8940e0f6e0d3d8',
      state: 'created',
      config: {
        ...config,
        env: { ...config.env, TEMPORAL_WORKER_SURFACE_HASH: ' old-generation ' },
      },
    });
    f.calls.length = 0;
    f.resetCounts();
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert(rows.every((row) => row.phase === 'UNKNOWN'));
    assert.deepEqual(f.counts(), { facts: 0, gets: 0 });
    assert.equal(f.calls.length, 0);
  });
  await test('the native app cohort reader uses one bounded read-only request and rejects unknown responses', async () => {
    const f = poolFixture();
    const calls: { url: string; method?: string }[] = [];
    const transport = createWorkerProcessTransport('private-test-key', (async (url, options) => {
      calls.push({ url: String(url), method: options?.method });
      return Response.json(f.pool);
    }) as typeof fetch);
    assert.deepEqual(await transport.listMachines(f.plan.app), f.pool);
    assert.deepEqual(calls, [
      { url: `https://api.machines.dev/v1/apps/${f.plan.app}/machines`, method: 'GET' },
    ]);
    await assert.rejects(transport.listMachines('../foreign-app'));
    assert.equal(calls.length, 1);
    for (const response of [{ machines: f.pool }, null]) {
      const invalid = createWorkerProcessTransport('private-test-key', (async () =>
        Response.json(response)) as typeof fetch);
      await assert.rejects(invalid.listMachines(f.plan.app), /complete native list/);
    }
  });
}
