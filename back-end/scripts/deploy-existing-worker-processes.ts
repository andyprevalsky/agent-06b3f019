#!/usr/bin/env tsx
/** Explicit process-only deployment. Never allocates/updates/stops a Machine or old worker. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';
import { config } from 'dotenv';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../src/providers/database';
import { readAgentQueuePointer, setCurrentAgentQueue } from '../src/providers/agentQueuePointer';
import { broadcastGenerationHandoff } from '../src/providers/generationHandoffBroadcast';
import {
  activateTemporalWorkerBuild,
  getTemporalClient,
  workerDeploymentActivationWorkflowId,
} from '../src/providers/temporal';
import { acquireWorkflowDeploymentLease } from '../src/providers/workflowDeploymentLease';
import {
  registerExistingWorkerProcesses,
  recoverExistingWorkerProcesses,
  requireBackendWorkerRecovery,
} from '../src/providers/workerProcessRecovery';
import { createWorkerProcessTransport } from '../src/providers/workerProcessTransport';
import {
  canonicalWorkerJSON,
  WORKER_PROCESS_BACKEND_ORIGIN,
  requireEightWorkerProcesses,
  validateWorkerProcessPlan,
  workerSHA256,
  workerPlanIdentity,
  type WorkerProcessPlan,
  type WorkerProcessArtifact,
  type HostProcessObservation,
} from '../src/providers/workerProcessDeployment';

function argument(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
  return value;
}
function transport(plan?: WorkerProcessPlan) {
  return createWorkerProcessTransport(
    process.env.FLY_API_TOKEN ?? '',
    fetch,
    plan
      ? { origin: plan.controlPlane.backendOrigin, planIdentity: workerPlanIdentity(plan) }
      : undefined
  );
}
export function requireCandidateRuntimeValidation(
  value: unknown,
  plan: WorkerProcessPlan
): string[] {
  const proof = value as {
    runId?: string;
    results?: { test: string; status: string }[];
    runtime?: {
      version?: number;
      sourceCommit?: string;
      bundleSHA256?: string;
      deploymentToken?: string;
      namespace?: string;
      taskQueue?: string;
      qualifiedIdentities?: string[];
      executingIdentities?: string[];
    };
  };
  const runtime = proof?.runtime;
  const required = [
    'candidate_image_initializes_before_activation',
    'candidate_history_is_deterministic',
    'candidate_restores_durable_state_without_llm_work',
    'candidate_fixture_cleanup',
  ];
  if (
    !proof?.runId ||
    !Array.isArray(proof.results) ||
    proof.results.some((row) => row.status !== 'PASS') ||
    !required.every(
      (test) =>
        proof.results!.filter((row) => row.test === test && row.status === 'PASS').length === 1
    ) ||
    runtime?.version !== 1 ||
    runtime.sourceCommit !== plan.artifact.sourceCommit ||
    runtime.bundleSHA256 !== plan.artifact.bundleSHA256 ||
    runtime.deploymentToken !== plan.attempt ||
    runtime.namespace !== plan.artifact.namespace ||
    runtime.taskQueue !== plan.artifact.validationTaskQueue ||
    !Array.isArray(runtime.qualifiedIdentities) ||
    runtime.qualifiedIdentities.length !== 8 ||
    new Set(runtime.qualifiedIdentities).size !== 8 ||
    !Array.isArray(runtime.executingIdentities) ||
    runtime.executingIdentities.length === 0 ||
    !runtime.executingIdentities.every((id) => runtime.qualifiedIdentities!.includes(id))
  )
    throw new Error('Exact native candidate validation and cleanup receipt is required');
  return runtime.qualifiedIdentities;
}

async function requireNativePollers(plan: WorkerProcessPlan, queue: string, identities: string[]) {
  const client = await getTemporalClient();
  if (client.options.namespace !== plan.artifact.namespace)
    throw new Error('Native namespace differs from the qualified runtime');
  for (const taskQueueType of [1, 2]) {
    const reply = await client.withDeadline(Date.now() + 10_000, () =>
      client.workflowService.describeTaskQueue({
        namespace: client.options.namespace,
        taskQueue: { name: queue },
        taskQueueType,
      })
    );
    const pollers = new Set(
      (reply.pollers ?? [])
        .filter((poller) => {
          const at = Number(poller.lastAccessTime?.seconds ?? 0) * 1000;
          return at <= Date.now() && Date.now() - at <= 120_000;
        })
        .map((poller) => poller.identity)
    );
    if (pollers.size !== 8 || !identities.every((identity) => pollers.has(identity)))
      throw new Error('All eight exact native workflow and activity pollers are required');
  }
}

function requireSourceCheckout(source: string): void {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf8',
  }).trim();
  if (head !== source) throw new Error('Process controller checkout does not match exact source');
}
async function capturePlan(): Promise<void> {
  const artifact = JSON.parse(
    readFileSync(argument('--artifact'), 'utf8')
  ) as WorkerProcessArtifact;
  requireSourceCheckout(artifact.sourceCommit);
  const ids = argument('--hosts').split(',');
  if (ids.length !== 8 || new Set(ids).size !== 8)
    throw new Error('Supply eight expressly authorized existing host IDs');
  const app = argument('--app');
  const pointer = await readAgentQueuePointer();
  if (!pointer?.taskQueue) throw new Error('Capture requires the actual current queue pointer');
  const native = transport();
  const hosts = [];
  for (const id of ids) {
    const machine = await native.getMachine(app, id);
    if (machine.id !== id || machine.state !== 'started' || !machine.image_ref?.digest)
      throw new Error('Exact original running host is unavailable');
    hosts.push({
      id,
      configSHA256: workerSHA256(canonicalWorkerJSON(machine.config)),
      imageDigest: machine.image_ref.digest,
    });
  }
  const plan: WorkerProcessPlan = {
    version: 1,
    peopleCredentialBrokerOrigin: WORKER_PROCESS_BACKEND_ORIGIN,
    app,
    attempt: artifact.deploymentToken,
    previousQueue: pointer.taskQueue,
    controlPlane: {
      serviceId: argument('--backend-service-id'),
      backendOrigin: WORKER_PROCESS_BACKEND_ORIGIN,
      databaseHost: new URL(process.env.DATABASE_URL ?? '').hostname,
      databaseName: new URL(process.env.DATABASE_URL ?? '').pathname.slice(1),
    },
    artifact,
    hosts,
    healthPort: 0,
    sdkMetricsPort: 0,
    limits: {
      maxAddressBytes: 1024 ** 3,
      aggregateMemoryBytes: 1024 ** 3,
      minFreeAfterMaxAddressBytes: 256 * 1024 ** 2,
      memoryController: 'v1-memory',
    },
  };
  validateWorkerProcessPlan(plan);
  const output = argument('--output');
  writeFileSync(output, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ captured: output, sourceCommit: artifact.sourceCommit, bundleSHA256: artifact.bundleSHA256, hosts: ids })}\n`
  );
}

async function observe(
  plan: WorkerProcessPlan,
  lease?: Awaited<ReturnType<typeof acquireWorkflowDeploymentLease>>
): Promise<HostProcessObservation[]> {
  return recoverExistingWorkerProcesses({
    transport: transport(plan),
    key: process.env.BACKEND_API_KEY ?? '',
    expectedIdentity: workerPlanIdentity(plan),
    ...(lease ? { lease } : {}),
  });
}
async function requirePointerCustody(plan: WorkerProcessPlan): Promise<void> {
  const pointer = await readAgentQueuePointer();
  const target = `${plan.artifact.baseTaskQueue}@${plan.artifact.surfaceHash}`;
  if (!pointer || ![plan.previousQueue, target].includes(pointer.taskQueue))
    throw new Error('Queue pointer no longer belongs to this process cutover');
}

async function activate(plan: WorkerProcessPlan): Promise<void> {
  const validatedIdentities = requireCandidateRuntimeValidation(
    JSON.parse(readFileSync(argument('--validation-receipt'), 'utf8')),
    plan
  );
  // The production backend must have observed this retained intent independently of this CLI.
  await requireBackendWorkerRecovery(plan);
  const lease = await acquireWorkflowDeploymentLease();
  try {
    await requirePointerCustody(plan);
    const client = await getTemporalClient();
    const markerId = workerDeploymentActivationWorkflowId(plan.artifact.buildId, plan.attempt);
    let markerExists = false;
    try {
      const marker = await client.withDeadline(Date.now() + 10_000, () =>
        client.workflow.getHandle(markerId).describe()
      );
      if (marker.status.name !== 'RUNNING')
        throw new Error('Existing activation intent is not running');
      markerExists = true;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    if (!markerExists) {
      const rows = await observe(plan, lease);
      const identities = requireEightWorkerProcesses(plan, rows, 'STANDBY');
      if (!identities.every((id) => validatedIdentities.includes(id)))
        throw new Error('Candidate cohort changed since its native validation');
      await requireNativePollers(plan, plan.artifact.validationTaskQueue, identities);
      await lease.assertOwned();
      await activateTemporalWorkerBuild(plan.artifact.buildId, plan.attempt);
    }
    const deadline = Date.now() + 180_000;
    let last: HostProcessObservation[] = [];
    while (Date.now() < deadline) {
      last = await observe(plan, lease);
      let ready = false;
      let identities: string[] = [];
      try {
        identities = requireEightWorkerProcesses(plan, last, 'RUNNING');
        const queue = `${plan.artifact.baseTaskQueue}@${plan.artifact.surfaceHash}`;
        await requireNativePollers(plan, queue, identities);
        ready = true;
      } catch (error) {
        if (Date.now() + 2000 >= deadline) throw error;
        process.stderr.write(
          `Runtime activation pending: ${last.map((row) => `${row.id}:${row.phase}`).join(',')}\n`
        );
      }
      if (ready) {
        if (Date.now() >= deadline)
          throw new Error('Activation readiness observation exceeded its deadline');
        await lease.assertOwned();
        const queue = `${plan.artifact.baseTaskQueue}@${plan.artifact.surfaceHash}`;
        await setCurrentAgentQueue(
          queue,
          plan.artifact.surfaceHash,
          `existing-process:${plan.attempt}`,
          { expectedCurrentQueue: plan.previousQueue }
        );
        process.stdout.write(
          `${JSON.stringify({ mode: 'existing-worker-process', sourceCommit: plan.artifact.sourceCommit, queue, nativeIdentities: identities, hosts: last, oldWorkers: 'retained and served; no retirement attempted' })}\n`
        );
        return;
      }
      await new Promise((done) => setTimeout(done, 2000));
    }
    throw new Error(
      'Exact eight-worker activation did not become ready; retained intent remains active'
    );
  } finally {
    await lease.release();
  }
}

/** Wake old-generation idle waits now; best-effort, after the lease is released. */
async function broadcastAfterActivation(plan: WorkerProcessPlan): Promise<void> {
  const liveQueue = `${plan.artifact.baseTaskQueue}@${plan.artifact.surfaceHash}`;
  if (!plan.previousQueue || plan.previousQueue === liveQueue) return;
  try {
    const report = await broadcastGenerationHandoff({ fromQueue: plan.previousQueue, liveQueue });
    process.stdout.write(`${JSON.stringify({ generationHandoffBroadcast: report })}\n`);
  } catch (error) {
    process.stderr.write(
      `Generation handoff broadcast failed; agents hand off at their next re-check: ${String(error)}\n`
    );
  }
}

async function main(): Promise<void> {
  config();
  if (!process.argv.includes('--execute'))
    throw new Error('Explicit --execute is required for native process operations');
  if (
    process.env.PRODUCTION_WORKER_PROCESS_DEPLOYMENT !== '1' ||
    !process.env.DATABASE_URL ||
    nonLocalDatabaseReason(process.env.DATABASE_URL) === null ||
    process.env.TEMPORAL_TASK_QUEUE !== 'navi-agent-tasks'
  )
    throw new Error(
      'Explicit production process opt-in, nonlocal database and production base queue are required'
    );
  const action = process.argv[2];
  if (action === 'capture-plan') {
    await capturePlan();
    return;
  }
  const plan = JSON.parse(readFileSync(argument('--plan'), 'utf8')) as WorkerProcessPlan;
  validateWorkerProcessPlan(plan);
  requireSourceCheckout(plan.artifact.sourceCommit);
  const database = new URL(process.env.DATABASE_URL);
  if (
    database.hostname !== plan.controlPlane.databaseHost ||
    database.pathname.slice(1) !== plan.controlPlane.databaseName
  )
    throw new Error('Process controller database differs from retained custody');
  if (action === 'activate') {
    await activate(plan);
    await broadcastAfterActivation(plan);
    return;
  }
  if (action === 'stage') {
    const lease = await acquireWorkflowDeploymentLease();
    try {
      await requirePointerCustody(plan);
      await registerExistingWorkerProcesses(plan, lease);
      const rows = await observe(plan, lease);
      process.stdout.write(
        `${JSON.stringify({ mode: 'existing-worker-process', staged: true, hosts: rows })}\n`
      );
    } finally {
      await lease.release();
    }
    return;
  }
  if (action !== 'verify-standby' && action !== 'verify-live')
    throw new Error('Unknown existing-process deployment action');
  const rows = await observe(plan);
  const phase = action === 'verify-live' ? 'RUNNING' : 'STANDBY';
  const identities = requireEightWorkerProcesses(plan, rows, phase);
  const queue =
    phase === 'RUNNING'
      ? `${plan.artifact.baseTaskQueue}@${plan.artifact.surfaceHash}`
      : plan.artifact.validationTaskQueue;
  await requireNativePollers(plan, queue, identities);
  if (phase === 'RUNNING') {
    const pointer = await readAgentQueuePointer();
    if (pointer?.taskQueue !== queue || pointer.surfaceHash !== plan.artifact.surfaceHash)
      throw new Error('Live pointer does not match exact process source');
    await requireBackendWorkerRecovery(plan, 'RUNNING');
  }
  process.stdout.write(
    `${JSON.stringify({ mode: 'existing-worker-process', phase, queue, nativeIdentities: identities, hosts: rows, oldWorkers: 'retained and served' })}\n`
  );
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
