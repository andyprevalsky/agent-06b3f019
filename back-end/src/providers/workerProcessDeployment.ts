import { createHash, createHmac } from 'node:crypto';

/** A second, owned runtime on an existing host. Machine image identity stays unchanged. */
export interface WorkerSourceFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}
export interface WorkerProcessArtifact {
  sourceCommit: string;
  buildId: string;
  surfaceHash: string;
  deploymentToken: string;
  namespace: string;
  baseTaskQueue: string;
  validationTaskQueue: string;
  bundleSHA256: string;
  bundleBase64: string;
  bootstrapSHA256: string;
  bootstrapSource: string;
  manifest: {
    version: 1;
    sourceCommit: string;
    requirementsSHA256: string;
    installedDistributionsSHA256: string;
    pythonSHA256: string;
    files: WorkerSourceFile[];
  };
}
export interface ExistingWorkerHost {
  id: string;
  configSHA256: string;
  imageDigest: string;
}
export interface WorkerProcessPlan {
  version: 1;
  app: string;
  attempt: string;
  previousQueue: string;
  artifact: WorkerProcessArtifact;
  hosts: ExistingWorkerHost[];
  healthPort: number;
  sdkMetricsPort: number;
  limits: {
    maxAddressBytes: number;
    aggregateMemoryBytes: number;
    minFreeAfterMaxAddressBytes: number;
    memoryController: 'v1-memory';
  };
}
export interface ProcessReceipt {
  version: 1;
  app: string;
  machineId: string;
  machineVersion: string;
  bootId: string;
  sourceCommit: string;
  bundleSHA256: string;
  buildId: string;
  deploymentToken: string;
  phase: 'MISSING' | 'BOOTING' | 'STANDBY' | 'RUNNING' | 'BLOCKED' | 'UNKNOWN';
  supervisorPid?: number;
  supervisorBirthTicks?: string;
  workerPid?: number;
  workerBirthTicks?: string;
  hostname?: string;
  healthPort?: number;
  health?: { healthy?: boolean; phase?: string; build_id?: string };
  aggregateMemoryBytes?: number;
}
export interface NativeWorkerHost {
  id: string;
  state: string;
  version: string;
  image_ref?: { digest?: string };
  config: unknown;
}
export interface RuntimeHostFacts {
  machineId: string;
  machineVersion: string;
  bootId: string;
  primary?: { pid: number; birthTicks: string; buildId: string; healthy: boolean; phase: string };
}
export interface WorkerProcessTransport {
  getMachine(app: string, id: string): Promise<NativeWorkerHost>;
  readFacts(app: string, id: string): Promise<RuntimeHostFacts>;
  execBootstrap(
    app: string,
    id: string,
    source: string,
    envelope: Record<string, unknown>
  ): Promise<ProcessReceipt>;
}
export interface HostProcessObservation {
  id: string;
  observedAt: number;
  primary?: RuntimeHostFacts['primary'];
  phase: ProcessReceipt['phase'];
  receipt?: ProcessReceipt;
  reason?: string;
}

/** Shared with the stdlib bootstrap: recursively sorted keys, integer-only metadata. */
export function canonicalWorkerJSON(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, visit(v)])
      );
    return item;
  };
  return JSON.stringify(visit(value));
}
export function workerSHA256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function workerPlanIdentity(plan: WorkerProcessPlan): string {
  return workerSHA256(canonicalWorkerJSON(plan));
}
const HEX = /^[a-f0-9]{64}$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateWorkerProcessPlan(plan: WorkerProcessPlan): void {
  requireValue(plan.version === 1, 'Unsupported worker process plan');
  requireValue(/^[a-z0-9][a-z0-9-]{1,62}$/.test(plan.app), 'Invalid existing worker app');
  requireValue(/^[a-zA-Z0-9._-]{1,80}$/.test(plan.attempt), 'Invalid worker attempt');
  requireValue(/^[a-zA-Z0-9@._-]{1,200}$/.test(plan.previousQueue), 'Missing exact prior queue');
  requireValue(plan.hosts.length === 8, 'Exactly eight existing worker hosts are required');
  requireValue(new Set(plan.hosts.map((host) => host.id)).size === 8, 'Duplicate existing host');
  for (const host of plan.hosts) {
    requireValue(/^[a-f0-9]{14}$/.test(host.id), 'Invalid existing host ID');
    requireValue(HEX.test(host.configSHA256), 'Missing existing config fingerprint');
    requireValue(/^sha256:[a-f0-9]{64}$/.test(host.imageDigest), 'Missing existing image digest');
  }
  const artifact = plan.artifact;
  requireValue(/^[a-f0-9]{40}$/.test(artifact.sourceCommit), 'Invalid worker source commit');
  requireValue(artifact.buildId === artifact.sourceCommit, 'Build does not bind source commit');
  requireValue(/^[a-f0-9]{12}$/.test(artifact.surfaceHash), 'Invalid worker surface hash');
  requireValue(artifact.deploymentToken === plan.attempt, 'Attempt token mismatch');
  requireValue(/^[a-zA-Z0-9._-]{1,200}$/.test(artifact.namespace), 'Missing native namespace');
  requireValue(/^[a-zA-Z0-9._-]+$/.test(artifact.baseTaskQueue), 'Invalid base queue');
  requireValue(
    artifact.validationTaskQueue === `navi-agent-candidate-${plan.attempt}`,
    'Missing exact validation queue'
  );
  requireValue(artifact.bundleBase64.length <= 24 * 1024 * 1024, 'Worker bundle exceeds bound');
  requireValue(
    workerSHA256(Buffer.from(artifact.bundleBase64, 'base64')) === artifact.bundleSHA256,
    'Worker bundle digest mismatch'
  );
  requireValue(artifact.bootstrapSource.length <= 128 * 1024, 'Worker bootstrap exceeds bound');
  requireValue(
    workerSHA256(artifact.bootstrapSource) === artifact.bootstrapSHA256,
    'Bootstrap digest mismatch'
  );
  requireValue(
    artifact.manifest.version === 1 && artifact.manifest.sourceCommit === artifact.sourceCommit,
    'Source manifest mismatch'
  );
  for (const digest of [
    artifact.manifest.requirementsSHA256,
    artifact.manifest.installedDistributionsSHA256,
    artifact.manifest.pythonSHA256,
  ])
    requireValue(HEX.test(digest), 'Incomplete runtime dependency identity');
  const files = artifact.manifest.files;
  requireValue(files.length > 0 && files.length <= 20_000, 'Invalid source file count');
  requireValue(
    new Set(files.map((file) => file.path)).size === files.length,
    'Duplicate source file'
  );
  for (const file of files) {
    requireValue(
      /^agents\/[a-zA-Z0-9_./-]+$/.test(file.path) &&
        !file.path.split('/').some((part) => part === '..' || part === '.' || part === ''),
      'Unsafe worker source path'
    );
    requireValue(
      !file.path
        .split('/')
        .some(
          (part) =>
            part.startsWith('.env') || ['venv', 'tests', 'benchmarks', 'vendor'].includes(part)
        ),
      'Non-runtime or private worker source path'
    );
    requireValue(
      HEX.test(file.sha256) && Number.isSafeInteger(file.size) && file.size >= 0,
      'Invalid source file digest/size'
    );
    requireValue(file.mode === 0o644 || file.mode === 0o755, 'Invalid source file mode');
  }
  requireValue(
    files.some((file) => file.path === 'agents/worker.py') &&
      files.some((file) => file.path === 'agents/requirements.txt'),
    'Incomplete worker entrypoint manifest'
  );
  requireValue(plan.limits.memoryController === 'v1-memory', 'Unqualified memory controller');
  requireValue(
    plan.limits.maxAddressBytes === 1024 ** 3 &&
      plan.limits.aggregateMemoryBytes === 1024 ** 3 &&
      plan.limits.minFreeAfterMaxAddressBytes === 256 * 1024 ** 2,
    'Unqualified coexistence resource bounds'
  );
  for (const port of [plan.healthPort, plan.sdkMetricsPort])
    requireValue(
      Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535)),
      'Invalid runtime port'
    );
  requireValue(
    plan.healthPort === 0 || plan.healthPort !== plan.sdkMetricsPort,
    'Runtime ports collide'
  );
  requireValue(
    ![8080, 9090].includes(plan.healthPort) && ![8080, 9090].includes(plan.sdkMetricsPort),
    'Runtime port touches primary worker'
  );
}

export function signWorkerEnvelope(
  plan: WorkerProcessPlan,
  host: NativeWorkerHost,
  facts: RuntimeHostFacts,
  action: 'status' | 'ensure',
  key: string
): Record<string, unknown> {
  requireValue(key.length > 0, 'Missing worker runtime authentication');
  const { artifact } = plan;
  const envelope = {
    version: 1,
    action,
    app: plan.app,
    machineId: host.id,
    machineVersion: host.version,
    bootId: facts.bootId,
    sourceCommit: artifact.sourceCommit,
    buildId: artifact.buildId,
    surfaceHash: artifact.surfaceHash,
    deploymentToken: artifact.deploymentToken,
    namespace: artifact.namespace,
    baseTaskQueue: artifact.baseTaskQueue,
    validationTaskQueue: artifact.validationTaskQueue,
    bundleSHA256: artifact.bundleSHA256,
    bundleBase64: action === 'ensure' ? artifact.bundleBase64 : null,
    manifest: artifact.manifest,
    limits: plan.limits,
    healthPort: plan.healthPort,
    sdkMetricsPort: plan.sdkMetricsPort,
  };
  return {
    ...envelope,
    signature: createHmac('sha256', key).update(canonicalWorkerJSON(envelope)).digest('hex'),
  };
}
function validateReceipt(
  plan: WorkerProcessPlan,
  host: NativeWorkerHost,
  facts: RuntimeHostFacts,
  receipt: ProcessReceipt
): void {
  const a = plan.artifact;
  requireValue(
    receipt.version === 1 &&
      receipt.app === plan.app &&
      receipt.machineId === host.id &&
      receipt.machineVersion === host.version &&
      receipt.bootId === facts.bootId,
    'Runtime receipt belongs to another host or boot'
  );
  requireValue(
    receipt.sourceCommit === a.sourceCommit &&
      receipt.bundleSHA256 === a.bundleSHA256 &&
      receipt.buildId === a.buildId &&
      receipt.deploymentToken === a.deploymentToken,
    'Runtime receipt belongs to another source or attempt'
  );
  requireValue(
    ['MISSING', 'BOOTING', 'STANDBY', 'RUNNING', 'BLOCKED', 'UNKNOWN'].includes(receipt.phase),
    'Invalid runtime phase'
  );
  if (receipt.phase === 'STANDBY' || receipt.phase === 'RUNNING') {
    requireValue(
      Number.isSafeInteger(receipt.workerPid) &&
        receipt.workerPid! > 1 &&
        /^\d+$/.test(receipt.workerBirthTicks ?? '') &&
        Number.isSafeInteger(receipt.supervisorPid) &&
        receipt.supervisorPid! > 1 &&
        /^\d+$/.test(receipt.supervisorBirthTicks ?? ''),
      'Runtime process identity is incomplete'
    );
    requireValue(
      receipt.aggregateMemoryBytes === plan.limits.aggregateMemoryBytes,
      'Runtime aggregate memory bound is unverified'
    );
    requireValue(
      receipt.health?.healthy === true &&
        receipt.health.build_id === a.buildId &&
        receipt.health.phase === (receipt.phase === 'STANDBY' ? 'standby' : 'running'),
      'Runtime health does not bind the actual candidate'
    );
    requireValue(
      typeof receipt.hostname === 'string' && receipt.hostname.length > 0,
      'Missing native process hostname'
    );
  }
}

/** Native calls are limited to GET exact IDs and authenticated process status/ensure. */
export async function reconcileWorkerProcesses(
  plan: WorkerProcessPlan,
  transport: WorkerProcessTransport,
  key: string,
  assertOwned: () => Promise<void>
): Promise<HostProcessObservation[]> {
  validateWorkerProcessPlan(plan);
  const rows: HostProcessObservation[] = [];
  for (const expected of plan.hosts) {
    try {
      await assertOwned();
      const host = await transport.getMachine(plan.app, expected.id);
      requireValue(
        host.id === expected.id && host.state === 'started' && !!host.version,
        'Existing worker is not running'
      );
      requireValue(
        workerSHA256(canonicalWorkerJSON(host.config)) === expected.configSHA256 &&
          host.image_ref?.digest === expected.imageDigest,
        'Existing worker config/image changed'
      );
      const facts = await transport.readFacts(plan.app, host.id);
      requireValue(
        facts.machineId === host.id &&
          facts.machineVersion === host.version &&
          /^[a-f0-9-]{36}$/.test(facts.bootId),
        'Existing worker boot identity is unknown'
      );
      const nativeConfig = host.config as { env?: Record<string, string> };
      requireValue(
        facts.primary?.healthy === true &&
          facts.primary.phase === 'running' &&
          Number.isSafeInteger(facts.primary.pid) &&
          facts.primary.pid > 1 &&
          /^\d+$/.test(facts.primary.birthTicks) &&
          !!facts.primary.buildId &&
          facts.primary.buildId === nativeConfig.env?.TEMPORAL_WORKER_BUILD_ID,
        'Original worker is not positively served'
      );
      await assertOwned();
      let receipt = await transport.execBootstrap(
        plan.app,
        host.id,
        plan.artifact.bootstrapSource,
        signWorkerEnvelope(plan, host, facts, 'status', key)
      );
      validateReceipt(plan, host, facts, receipt);
      // Only a positive MISSING receipt permits ensure. UNKNOWN never means absent.
      if (receipt.phase === 'MISSING') {
        await assertOwned();
        receipt = await transport.execBootstrap(
          plan.app,
          host.id,
          plan.artifact.bootstrapSource,
          signWorkerEnvelope(plan, host, facts, 'ensure', key)
        );
        validateReceipt(plan, host, facts, receipt);
      }
      await assertOwned();
      rows.push({
        id: expected.id,
        observedAt: Date.now(),
        primary: facts.primary,
        phase: receipt.phase,
        receipt,
      });
    } catch (error) {
      rows.push({
        id: expected.id,
        observedAt: Date.now(),
        phase: 'UNKNOWN',
        reason: error instanceof Error ? error.message : 'Runtime observation failed',
      });
    }
  }
  return rows;
}

export function requireEightWorkerProcesses(
  plan: WorkerProcessPlan,
  rows: HostProcessObservation[],
  phase: 'STANDBY' | 'RUNNING'
): string[] {
  validateWorkerProcessPlan(plan);
  requireValue(
    rows.length === 8 && new Set(rows.map((row) => row.id)).size === 8,
    'Missing or duplicate runtime hosts'
  );
  const identities: string[] = [];
  for (const host of plan.hosts) {
    const row = rows.find((item) => item.id === host.id);
    requireValue(
      row?.phase === phase && row.receipt,
      'All eight exact runtime processes are required'
    );
    const receipt = row.receipt;
    requireValue(
      row.primary?.healthy === true &&
        row.primary.phase === 'running' &&
        Number.isSafeInteger(row.primary.pid) &&
        row.primary.pid > 1 &&
        /^\d+$/.test(row.primary.birthTicks),
      'Original worker custody is not positively served'
    );
    requireValue(
      Number.isFinite(row.observedAt) &&
        row.observedAt <= Date.now() &&
        Date.now() - row.observedAt <= 60_000,
      'Runtime cohort observation is stale'
    );
    requireValue(
      !!receipt.machineVersion && /^[a-f0-9-]{36}$/.test(receipt.bootId),
      'Runtime host boot is unverified'
    );
    validateReceipt(
      plan,
      { id: host.id, state: 'started', version: receipt.machineVersion, config: null },
      { machineId: host.id, machineVersion: receipt.machineVersion, bootId: receipt.bootId },
      receipt
    );
    requireValue(
      receipt.buildId === plan.artifact.buildId &&
        receipt.bundleSHA256 === plan.artifact.bundleSHA256 &&
        receipt.deploymentToken === plan.attempt &&
        receipt.health?.phase === (phase === 'STANDBY' ? 'standby' : 'running') &&
        receipt.health.healthy === true &&
        receipt.aggregateMemoryBytes === plan.limits.aggregateMemoryBytes,
      'Runtime cohort provenance is incomplete'
    );
    identities.push(`${receipt.workerPid}@${receipt.hostname}`);
  }
  requireValue(new Set(identities).size === 8, 'Duplicate native worker identities');
  return identities;
}
