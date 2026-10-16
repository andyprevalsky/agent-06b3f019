import { randomUUID } from 'node:crypto';
import {
  canonicalWorkerJSON,
  workerSHA256,
  type ProcessReceipt,
  type WorkerProcessPlan,
  type WorkerProcessTransport,
} from '../../providers/workerProcessDeployment';

export const config = { env: { TEMPORAL_WORKER_BUILD_ID: 'old' }, image: 'old' };
export function fixture() {
  const source = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const plan: WorkerProcessPlan = {
    version: 1,
    app: 'owned-production-app',
    attempt: 'qualified-attempt-1',
    controlPlane: {
      serviceId: 'srv-local-fixture',
      databaseHost: 'qualified.remote.test',
      databaseName: 'production',
    },
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
