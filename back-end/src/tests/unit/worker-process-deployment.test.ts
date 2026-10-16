import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  canonicalWorkerJSON,
  reconcileWorkerProcesses,
  requireEightWorkerProcesses,
  signWorkerEnvelope,
  validateWorkerProcessPlan,
  workerSHA256,
  workerPlanIdentity,
  type ProcessReceipt,
  type WorkerProcessPlan,
  type WorkerProcessTransport,
} from '../../providers/workerProcessDeployment';
import { createTestHarness } from './trace-archive-test-utils';
import {
  recoverExistingWorkerProcesses,
  type WorkerProcessRepository,
} from '../../providers/workerProcessRecovery';
import { createWorkerProcessTransport } from '../../providers/workerProcessTransport';
import { setCurrentAgentQueue } from '../../providers/agentQueuePointer';
import { prisma } from '../../providers/database';
import { requireCandidateRuntimeValidation } from '../../../scripts/deploy-existing-worker-processes';

const { test, finish } = createTestHarness('existing worker process deployment');
const config = { env: { TEMPORAL_WORKER_BUILD_ID: 'old' }, image: 'old' };
function fixture() {
  const source = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const plan: WorkerProcessPlan = {
    version: 1,
    app: 'owned-production-app',
    attempt: 'qualified-attempt-1',
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
async function main() {
  await test('eight exact standby runtimes are distinct from unchanged native image identity', async () => {
    const f = fixture();
    const before = structuredClone(config);
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert.equal(requireEightWorkerProcesses(f.plan, rows, 'STANDBY').length, 8);
    assert.deepEqual(config, before);
    assert(f.calls.every((call) => call.action === 'status' && !call.hasBundle));
  });
  await test('only positive absence permits ensure; UNKNOWN and BLOCKED retain host untouched', async () => {
    for (const phase of ['UNKNOWN', 'BLOCKED', 'MISSING'] as const) {
      const f = fixture();
      f.setPhase(phase);
      const rows = await reconcileWorkerProcesses(
        f.plan,
        f.transport,
        'private-test-key',
        async () => {}
      );
      assert.equal(
        f.calls.filter((call) => call.action === 'ensure').length,
        phase === 'MISSING' ? 8 : 0
      );
      assert.throws(() => requireEightWorkerProcesses(f.plan, rows, 'STANDBY'));
    }
  });
  await test('native config/image drift and foreign boot receipts cannot qualify or launch', async () => {
    for (const mode of ['config', 'boot']) {
      const f = fixture();
      if (mode === 'config') f.changeConfig();
      else f.changeBoot();
      const rows = await reconcileWorkerProcesses(
        f.plan,
        f.transport,
        'private-test-key',
        async () => {}
      );
      assert(rows.every((row) => row.phase === 'UNKNOWN'));
      assert(!f.calls.some((call) => call.action === 'ensure'));
      assert.throws(() => requireEightWorkerProcesses(f.plan, rows, 'STANDBY'));
    }
  });
  await test('lost exec acknowledgement is UNKNOWN and the next tick observes before ensuring', async () => {
    const f = fixture();
    const original = f.transport.execBootstrap;
    f.transport.execBootstrap = async () => {
      throw new Error('native observation uncertain');
    };
    const first = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert(first.every((row) => row.phase === 'UNKNOWN'));
    f.transport.execBootstrap = original;
    await reconcileWorkerProcesses(f.plan, f.transport, 'private-test-key', async () => {});
    assert(f.calls.every((call) => call.action === 'status'));
  });
  await test('lease loss forbids process actions and bundle/private source changes fail before native IO', async () => {
    const f = fixture();
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {
        throw new Error('lease lost');
      }
    );
    assert(rows.every((row) => row.phase === 'UNKNOWN'));
    assert.equal(f.calls.length, 0);
    f.plan.artifact.bundleBase64 = Buffer.from('tampered').toString('base64');
    await assert.rejects(
      reconcileWorkerProcesses(f.plan, f.transport, 'private-test-key', async () => {}),
      /digest/
    );
    assert.equal(f.calls.length, 0);
    const other = fixture();
    other.plan.artifact.manifest.files.push({
      path: 'agents/.env',
      mode: 0o644,
      size: 1,
      sha256: 'b'.repeat(64),
    });
    assert.throws(() => validateWorkerProcessPlan(other.plan), /private/);
  });
  await test('signed status omits source bytes but binds boot, source, attempt and hard resource policy', () => {
    const f = fixture();
    const host = { id: f.plan.hosts[0].id, version: 'instance', state: 'started', config };
    const facts = { machineId: host.id, machineVersion: host.version, bootId: randomUUID() };
    const status = signWorkerEnvelope(f.plan, host, facts, 'status', 'private-test-key');
    const ensure = signWorkerEnvelope(f.plan, host, facts, 'ensure', 'private-test-key');
    assert.equal(status.bundleBase64, null);
    assert.equal(ensure.bundleBase64, f.plan.artifact.bundleBase64);
    assert.notEqual(status.signature, ensure.signature);
    assert.equal(status.bootId, facts.bootId);
    assert.deepEqual(status.limits, f.plan.limits);
  });
  await test('retained desired state restores a positively missing process after backend and host restart', async () => {
    const f = fixture();
    f.setPhase('MISSING');
    const identity = workerPlanIdentity(f.plan);
    const records: unknown[] = [];
    const repository: WorkerProcessRepository = {
      async read() {
        return { version: 1, identity, plan: f.plan };
      },
      async record(expected, rows) {
        assert.equal(expected, identity);
        records.push(rows);
        return true;
      },
    };
    let releases = 0;
    const rows = await recoverExistingWorkerProcesses({
      repository,
      transport: f.transport,
      key: 'private-test-key',
      acquireLease: async () => ({
        ownerId: 'owned-recovery',
        assertOwned: async () => {},
        release: async () => {
          releases++;
        },
      }),
    });
    assert(rows.every((row) => row.phase === 'BOOTING'));
    assert.equal(records.length, 1);
    assert.equal(releases, 1);
    assert.equal(f.calls.filter((call) => call.action === 'ensure').length, 8);
    assert.throws(() => requireEightWorkerProcesses(f.plan, rows, 'RUNNING'));
  });
  await test('no desired intent has no native or lease effects; replaced intent denies before recovery', async () => {
    const f = fixture();
    let reads = 0;
    let acquired = 0;
    let releases = 0;
    const acquireLease = async () => {
      acquired++;
      return {
        ownerId: 'recovery',
        assertOwned: async () => {},
        release: async () => {
          releases++;
        },
      };
    };
    const absent: WorkerProcessRepository = {
      read: async () => undefined,
      record: async () => {
        throw new Error('unexpected record');
      },
    };
    assert.deepEqual(
      await recoverExistingWorkerProcesses({
        repository: absent,
        transport: f.transport,
        key: '',
        acquireLease,
      }),
      []
    );
    assert.equal(acquired, 0);
    const changed: WorkerProcessRepository = {
      async read() {
        reads++;
        return reads === 1
          ? { version: 1, identity: workerPlanIdentity(f.plan), plan: f.plan }
          : undefined;
      },
      record: async () => {
        throw new Error('unexpected record');
      },
    };
    await assert.rejects(
      recoverExistingWorkerProcesses({
        repository: changed,
        transport: f.transport,
        key: 'private-test-key',
        acquireLease,
      }),
      /changed/
    );
    assert.equal(releases, 1);
    assert.equal(f.calls.length, 0);
  });
  await test('native transport exposes only exact-ID GET and bounded exec, never allocation or Machine controls', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const transport = createWorkerProcessTransport('private-test-key', (async (url, options) => {
      calls.push({
        url: String(url),
        method: options?.method ?? '',
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      });
      return new Response(
        JSON.stringify(
          options?.method === 'GET'
            ? { id: '00000000000000' }
            : { exit_code: 0, exit_signal: 0, stdout: '{}' }
        )
      );
    }) as typeof fetch);
    await transport.getMachine('owned-production-app', '00000000000000');
    await transport.readFacts('owned-production-app', '00000000000000');
    await transport.execBootstrap('owned-production-app', '00000000000000', '# trusted bootstrap', {
      signature: 'signed',
    });
    assert.equal(calls[0].method, 'GET');
    assert(
      calls
        .slice(1)
        .every(
          (call) => call.method === 'POST' && call.url.endsWith('/machines/00000000000000/exec')
        )
    );
    assert(calls.every((call) => !/clone|update|destroy|start|stop/.test(call.url)));
    const count = calls.length;
    await assert.rejects(transport.getMachine('../another-app', '00000000000000'));
    assert.equal(calls.length, count);
  });
  await test('cohort qualification rechecks process and host identity instead of trusting a saved phase', async () => {
    const f = fixture();
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    const missingIdentity = structuredClone(rows);
    delete missingIdentity[0].receipt!.workerPid;
    assert.throws(() => requireEightWorkerProcesses(f.plan, missingIdentity, 'STANDBY'));
    const foreignReceipt = structuredClone(rows);
    foreignReceipt[1].receipt = foreignReceipt[0].receipt;
    assert.throws(() => requireEightWorkerProcesses(f.plan, foreignReceipt, 'STANDBY'));
    const stale = structuredClone(rows);
    stale[0].observedAt = Date.now() - 60_001;
    assert.throws(() => requireEightWorkerProcesses(f.plan, stale, 'STANDBY'), /stale/);
  });
  await test('original worker absence blocks candidate ensure and cohort readiness', async () => {
    const f = fixture();
    f.setPhase('MISSING');
    const original = f.transport.readFacts;
    f.transport.readFacts = async (app, id) => ({
      ...(await original(app, id)),
      primary: undefined,
    });
    const rows = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'private-test-key',
      async () => {}
    );
    assert(rows.every((row) => row.phase === 'UNKNOWN'));
    assert.equal(f.calls.length, 0);
  });
  await test('source packaging binds committed bytes and canonical surface while excluding private and installed inputs', () => {
    const root = resolve(__dirname, '../../../..');
    const repository = mkdtempSync(join(tmpdir(), 'worker-source-owner-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repository, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      mkdirSync(join(repository, 'agents/workflows'), { recursive: true });
      mkdirSync(join(repository, 'agents/scripts'), { recursive: true });
      mkdirSync(join(repository, 'agents/tests'), { recursive: true });
      mkdirSync(join(repository, 'scripts'), { recursive: true });
      writeFileSync(join(repository, 'agents/worker.py'), 'committed = True\n');
      writeFileSync(
        join(repository, 'agents/workflows/agent_workflow.py'),
        'class AgentWorkflow: pass\n'
      );
      writeFileSync(join(repository, 'agents/requirements.txt'), 'qualified-dependency==1\n');
      writeFileSync(join(repository, 'agents/.env'), 'FAKE_PRIVATE_EXCLUSION_MARKER=1\n');
      writeFileSync(join(repository, 'agents/tests/test.py'), 'not runtime\n');
      writeFileSync(join(repository, 'scripts/production_worker_process.py'), '# test bootstrap\n');
      writeFileSync(
        join(repository, 'scripts/agent_workflow_surface_hash.py'),
        readFileSync(join(root, 'scripts/agent_workflow_surface_hash.py'))
      );
      git('init', '-q');
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-qm',
        'source fixture'
      );
      const commit = git('rev-parse', 'HEAD');
      writeFileSync(join(repository, 'agents/worker.py'), 'UNCOMMITTED_MUTATION\n');
      const args = [
        join(root, 'scripts/build-existing-worker-bundle.py'),
        '--repository',
        repository,
        '--source-commit',
        commit,
        '--dependency-digest',
        'b'.repeat(64),
        '--python-digest',
        'c'.repeat(64),
        '--namespace',
        'fixture',
        '--attempt',
        'fixture-attempt',
      ];
      const output = execFileSync('python3', args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      const artifact = JSON.parse(output) as WorkerProcessPlan['artifact'];
      assert.equal(artifact.sourceCommit, commit);
      assert.equal(artifact.bootstrapSource, '# test bootstrap\n');
      assert.equal(
        artifact.manifest.files.find((file) => file.path === 'agents/worker.py')?.sha256,
        workerSHA256('committed = True\n')
      );
      assert(
        !artifact.manifest.files.some((file) => /\.env|\/tests\/|\/scripts\//.test(file.path))
      );
      const bytes = gunzipSync(Buffer.from(artifact.bundleBase64, 'base64')).toString();
      assert(
        !bytes.includes('FAKE_PRIVATE_EXCLUSION_MARKER') && !bytes.includes('UNCOMMITTED_MUTATION')
      );
      assert.equal(
        JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
          .bundleSHA256,
        artifact.bundleSHA256
      );
      symlinkSync('/etc/passwd', join(repository, 'agents/unsafe.py'));
      git('add', 'agents/unsafe.py');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-qm',
        'unsafe source fixture'
      );
      args[args.indexOf('--source-commit') + 1] = git('rev-parse', 'HEAD');
      const rejected = spawnSync('python3', args, { encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /regular files/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
  await test('process cutover pointer CAS preserves an unexpectedly advanced destination', async () => {
    const original = prisma.$transaction;
    let writes = 0;
    const tx = {
      $executeRaw: async () => 0,
      agentQueuePointer: {
        findUnique: async () => ({ taskQueue: 'third-party-queue', surfaceHash: 'd'.repeat(12) }),
        upsert: async () => {
          writes++;
        },
      },
      toolSideEffect: {
        findUnique: async () => null,
        create: async () => {
          writes++;
        },
      },
    };
    try {
      prisma.$transaction = (async (fn: (value: unknown) => Promise<unknown>) =>
        fn(tx)) as unknown as typeof prisma.$transaction;
      await assert.rejects(
        setCurrentAgentQueue('navi-agent-tasks@cccccccccccc', 'cccccccccccc', 'process-attempt', {
          expectedCurrentQueue: 'previous-qualified-queue',
        }),
        /changed/
      );
      assert.equal(writes, 0);
    } finally {
      prisma.$transaction = original;
    }
  });
  await test('activation requires exact native source, queue, attempt and successful fixture cleanup', async () => {
    const { plan } = fixture();
    const receipt = {
      runId: 'native-validation-id',
      results: [
        'candidate_image_initializes_before_activation',
        'candidate_history_is_deterministic',
        'candidate_restores_durable_state_without_llm_work',
        'candidate_fixture_cleanup',
      ].map((test) => ({ test, status: 'PASS' })),
      runtime: {
        version: 1,
        sourceCommit: plan.artifact.sourceCommit,
        bundleSHA256: plan.artifact.bundleSHA256,
        deploymentToken: plan.attempt,
        namespace: plan.artifact.namespace,
        taskQueue: plan.artifact.validationTaskQueue,
      },
    };
    requireCandidateRuntimeValidation(receipt, plan);
    for (const field of [
      'sourceCommit',
      'bundleSHA256',
      'deploymentToken',
      'namespace',
      'taskQueue',
    ] as const) {
      const changed = structuredClone(receipt);
      changed.runtime[field] = 'foreign';
      assert.throws(() => requireCandidateRuntimeValidation(changed, plan));
    }
    const missingCleanup = structuredClone(receipt);
    missingCleanup.results.pop();
    assert.throws(() => requireCandidateRuntimeValidation(missingCleanup, plan));
    const failed = structuredClone(receipt);
    failed.results[0].status = 'FAIL';
    assert.throws(() => requireCandidateRuntimeValidation(failed, plan));
    assert.throws(() => requireCandidateRuntimeValidation(null, plan));
  });
  finish();
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
