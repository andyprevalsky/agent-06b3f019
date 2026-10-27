import {
  PhysicalRootReconciliationRequired,
  physicalWitnessKey,
  observePhysicalRootWitness,
  type RootTerminalWitness,
} from './workflowPhysicalStart';
import { createHash } from 'node:crypto';
import {
  Connection,
  Client,
  defaultPayloadConverter,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { createLogger } from './logger';
import { getCurrentAgentQueue } from './agentQueuePointer';
import {
  nativeWorkflowTerminal,
  WorkflowStartAdmissionPendingError,
  claimWorkflowStart,
  retainPendingWorkflowStart,
  acknowledgeWorkflowStart,
  type StartAdmission,
} from './workflowQueueAdmission';
import type { WorkflowLaunchConfig, WorkflowResumeState } from './workflowReplacementState';
import {
  createBlackboxTemporalClient,
  shouldUseBlackboxTemporalFake,
} from './temporalBlackboxFake';

const log = createLogger('Temporal');

let client: Client | null = null;
export const TEMPORAL_CONTROL_RPC_TIMEOUT_MS = 15_000;
export const WORKER_DEPLOYMENT_ACTIVATION_PREFIX = 'navi-worker-deployment-activation:';
export const WORKER_DEPLOYMENT_ACTIVATION_TASK_QUEUE = 'navi-worker-deployment-markers';
export const DESCENDANT_START_TOMBSTONE_TASK_QUEUE = 'navi-deployment-descendant-start-tombstones';
const WORKER_DEPLOYMENT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isLocalTemporalAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized === '::1') return true;
  const host = normalized.startsWith('[')
    ? normalized.slice(1, normalized.indexOf(']'))
    : normalized.split(':', 1)[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function withTemporalControlDeadline<T>(
  temporalClient: Pick<Client, 'withDeadline'>,
  operation: () => Promise<T>,
  deadlineAtMs?: number
): Promise<T> {
  const rpcDeadline = Date.now() + TEMPORAL_CONTROL_RPC_TIMEOUT_MS;
  return temporalClient.withDeadline(
    deadlineAtMs === undefined ? rpcDeadline : Math.min(rpcDeadline, deadlineAtMs),
    operation
  );
}

export function workerDeploymentActivationWorkflowId(
  buildId: string,
  deploymentToken: string
): string {
  if (!/^[0-9a-f]{40}$/.test(buildId)) {
    throw new Error('Temporal worker build ID must be a lowercase 40-character Git SHA');
  }
  if (!WORKER_DEPLOYMENT_TOKEN_PATTERN.test(deploymentToken)) {
    throw new Error('Temporal worker deployment token must be 1-80 safe ID characters');
  }
  return `${WORKER_DEPLOYMENT_ACTIVATION_PREFIX}${buildId}:${deploymentToken}`;
}

export async function activateTemporalWorkerBuildWithClient(
  temporalClient: Pick<Client, 'withDeadline' | 'workflow'>,
  buildId: string,
  deploymentToken: string,
  deadlineAtMs?: number
): Promise<string> {
  const workflowId = workerDeploymentActivationWorkflowId(buildId, deploymentToken);
  try {
    const description = await withTemporalControlDeadline(
      temporalClient,
      () => temporalClient.workflow.getHandle(workflowId).describe(),
      deadlineAtMs
    );
    if (description.status.name !== 'RUNNING') {
      throw new Error(
        `Temporal worker activation marker ${workflowId} is ${description.status.name}`
      );
    }
    return workflowId;
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
  }

  try {
    await withTemporalControlDeadline(
      temporalClient,
      () =>
        temporalClient.workflow.start('RoseWorkerDeploymentActivationMarker', {
          taskQueue: WORKER_DEPLOYMENT_ACTIVATION_TASK_QUEUE,
          workflowId,
          args: [buildId, deploymentToken],
        }),
      deadlineAtMs
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  return workflowId;
}

export async function activateTemporalWorkerBuild(
  buildId: string,
  deploymentToken: string,
  deadlineAtMs?: number
): Promise<string> {
  return activateTemporalWorkerBuildWithClient(
    await getTemporalClient(),
    buildId,
    deploymentToken,
    deadlineAtMs
  );
}

export async function cleanupSupersededWorkerActivationMarkersWithClient(
  temporalClient: Pick<Client, 'withDeadline' | 'workflow'>,
  currentMarkerWorkflowId: string,
  deadlineAtMs = Date.now() + 120_000
): Promise<number> {
  let terminated = 0;
  await temporalClient.withDeadline(deadlineAtMs, async () => {
    for await (const execution of temporalClient.workflow.list({
      query: 'WorkflowType="RoseWorkerDeploymentActivationMarker" AND ExecutionStatus="Running"',
    })) {
      if (
        execution.workflowId === currentMarkerWorkflowId ||
        !execution.workflowId.startsWith(WORKER_DEPLOYMENT_ACTIVATION_PREFIX)
      ) {
        continue;
      }
      try {
        await temporalClient.workflow
          .getHandle(execution.workflowId, execution.runId)
          .terminate('Superseded worker deployment activation marker');
        terminated += 1;
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    }
  });
  return terminated;
}

export async function cleanupSupersededWorkerActivationMarkers(
  currentMarkerWorkflowId: string,
  deadlineAtMs?: number
): Promise<number> {
  return cleanupSupersededWorkerActivationMarkersWithClient(
    await getTemporalClient(),
    currentMarkerWorkflowId,
    deadlineAtMs
  );
}

/**
 * Get or create a Temporal client connected to Temporal Cloud
 */
export async function getTemporalClient(): Promise<Client> {
  if (client) {
    return client;
  }

  if (shouldUseBlackboxTemporalFake()) {
    const namespace = process.env.TEMPORAL_NAMESPACE || 'blackbox';
    client = createBlackboxTemporalClient(namespace);
    log.info('Using in-memory Temporal client for blackbox route contracts', { namespace });
    return client;
  }

  const address = process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!namespace) {
    throw new Error('Missing TEMPORAL_NAMESPACE environment variable');
  }

  const isLocal = isLocalTemporalAddress(address);
  if (!apiKey && !isLocal) {
    throw new Error('Missing TEMPORAL_API_KEY environment variable');
  }

  log.info(isLocal ? 'Connecting to local Temporal...' : 'Connecting to Temporal Cloud...', {
    address,
    namespace,
  });

  const connection = await Connection.connect(
    isLocal
      ? { address, tls: false }
      : {
          address,
          tls: true, // Required for Temporal Cloud
          apiKey, // Use apiKey directly (simpler than metadata)
        }
  );

  client = new Client({
    connection,
    namespace,
  });

  log.info(isLocal ? 'Connected to local Temporal' : 'Connected to Temporal Cloud');

  return client;
}

export interface TemporalWorkflowExecutionRef {
  workflowId: string;
  firstExecutionRunId: string;
}

export interface StartAgentWorkflowParams {
  agentId: string;
  userId: string;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  verifier: {
    type: string;
  };
  taskQueue?: string; // Optional: override task queue (for testing isolation)
  parentWorkflowId?: string; // Optional: parent workflow ID for sub-agents
  parentAgentId?: string; // Optional: parent agent ID for tree structure
  depth?: number; // Optional: nesting depth
  busId?: string; // Optional: shared bus channel ID for sub-agent tree updates
  startPhase?: 'plan' | 'execute' | 'browser' | 'resume'; // 'resume' is internal deployment recovery
  maxIterations?: number; // Optional: step limit for execute phase (sub-agents use 25)
  priceLimitCents?: number; // Optional: price limit in cents (default 100)
  contextGates?: {
    // Optional: control which user context sections the agent receives
    user_profile?: boolean;
    authenticated_sessions?: boolean;
    integrations?: boolean;
    recent_communications?: boolean;
    network?: boolean;
    custom_system_prompt?: boolean;
    shared_files?: boolean;
  };
  fastModeCacheEnabled?: boolean; // Optional: DEMO cache (own flag, not a gate)
  memoryEnabled?: boolean; // Optional: planner memory (get_memories fork); arg #19, only sent when true
  worldModelMode?: 'real' | 'simulate' | 'shadow'; // Per-agent provider/environment execution mode
  workflowId?: string; // Optional preclaimed generation-specific workflow ID
  resumeState?: WorkflowResumeState; // Durable state captured before deployment replacement
  rejectDuplicateWorkflowId?: boolean; // Durable child-start outbox uses one immutable ID.
}

function parseContextGates(value: unknown): Record<string, boolean> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Historical workflow context gates are malformed');
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')) {
    throw new Error('Historical workflow context gates are malformed');
  }
  return Object.fromEntries(entries);
}

/** Extract only the two launch inputs that were not historically persisted in Postgres. */
export function parseAgentWorkflowLaunchConfig(args: unknown[]): WorkflowLaunchConfig {
  const maxIterations = args[12];
  if (
    maxIterations !== null &&
    maxIterations !== undefined &&
    (!Number.isInteger(maxIterations) || Number(maxIterations) < 1)
  ) {
    throw new Error('Historical workflow max iterations are malformed');
  }
  return {
    maxIterations:
      maxIterations === null || maxIterations === undefined ? null : Number(maxIterations),
    contextGates: parseContextGates(args[14]),
  };
}

export function buildAgentWorkflowStartHistoryRequest(namespace: string, workflowId: string) {
  return {
    namespace,
    execution: { workflowId },
    maximumPageSize: 1,
    waitNewEvent: false,
    skipArchival: true,
  } as const;
}

/** Read one start event; this does not fetch or replay the workflow's history. */
export async function readAgentWorkflowLaunchConfig(
  workflowId: string,
  deadlineAtMs?: number
): Promise<WorkflowLaunchConfig> {
  const temporalClient = await getTemporalClient();
  let response;
  try {
    response = await temporalClient.withDeadline(
      Math.min(Date.now() + 10_000, deadlineAtMs ?? Number.POSITIVE_INFINITY),
      () =>
        temporalClient.workflowService.getWorkflowExecutionHistory(
          buildAgentWorkflowStartHistoryRequest(temporalClient.options.namespace, workflowId)
        )
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 5) {
      throw new WorkflowNotFoundError('Workflow history was not found', workflowId, undefined);
    }
    throw error;
  }
  const started = response.history?.events?.[0]?.workflowExecutionStartedEventAttributes;
  if (started === null || started === undefined) {
    throw new Error(`Temporal did not return the start event for ${workflowId}`);
  }
  const args = (started.input?.payloads ?? []).map((payload) =>
    defaultPayloadConverter.fromPayload(payload)
  );
  return parseAgentWorkflowLaunchConfig(args);
}

export function buildAgentWorkflowArgs(params: StartAgentWorkflowParams): unknown[] {
  // Simulator/shadow must never inherit the real-mode Fast Mode default — those
  // modes race different providers and Fast Mode would poison cache keys/tiers.
  const fastModeCacheEnabled =
    params.worldModelMode !== undefined && params.worldModelMode !== 'real'
      ? false
      : (params.fastModeCacheEnabled ?? true);

  const args: unknown[] = [
    params.agentId,
    params.userId,
    params.goal,
    params.model,
    params.reasoningMaxTokens,
    { type: params.verifier.type },
    [],
    params.parentWorkflowId || null,
    params.parentAgentId || null,
    params.depth || 0,
    params.busId || null,
    params.startPhase || 'plan',
    params.maxIterations || null,
    params.priceLimitCents || 100,
    params.contextGates || null,
    fastModeCacheEnabled,
  ];
  // Keep ordinary real-mode starts compatible with the previous 16-argument
  // worker. Deployment state remains #17; Simulator mode uses #18 so it does
  // not change the durable replacement contract.
  if (
    params.resumeState !== undefined ||
    (params.worldModelMode !== undefined && params.worldModelMode !== 'real')
  ) {
    args.push(params.resumeState ?? null);
  }
  if (params.worldModelMode !== undefined && params.worldModelMode !== 'real') {
    args.push(params.worldModelMode);
  }
  // Planner memory is #19. Only sent when on so every existing start stays
  // byte-identical; when on, #17/#18 are filled with their defaults first.
  if (params.memoryEnabled === true) {
    if (args.length < 17) args.push(params.resumeState ?? null);
    if (args.length < 18) args.push(params.worldModelMode ?? 'real');
    args.push(true);
  }
  return args;
}

/** Resolve the immutable chain identity for an already-started workflow. */
export async function resolveTemporalWorkflowExecutionRefWithClient(
  temporalClient: Pick<Client, 'withDeadline' | 'workflow'>,
  workflowId: string,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  const description = await withTemporalControlDeadline(
    temporalClient,
    () => temporalClient.workflow.getHandle(workflowId).describe(),
    deadlineAtMs
  );
  const firstExecutionRunId = description.raw.workflowExecutionInfo?.firstRunId;
  if (typeof firstExecutionRunId !== 'string' || firstExecutionRunId.length === 0) {
    throw new Error(`Temporal did not return a first execution run ID for ${workflowId}`);
  }
  return { workflowId, firstExecutionRunId };
}

export async function resolveTemporalWorkflowExecutionRef(
  workflowId: string,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  return resolveTemporalWorkflowExecutionRefWithClient(
    await getTemporalClient(),
    workflowId,
    deadlineAtMs
  );
}

/**
 * Resolve an ambiguous descendant start without ever assuming a timed-out RPC
 * was rejected. Starting an unserved tombstone under the same immutable
 * Workflow ID makes the race total: either the original AgentWorkflow won, or
 * this inert execution did. The caller then terminates the exact winning chain
 * before clearing its durable outbox row.
 */
export async function claimTemporalWorkflowIdForTerminationWithClient(
  temporalClient: Pick<Client, 'withDeadline' | 'workflow'>,
  workflowId: string,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  try {
    const handle = await withTemporalControlDeadline(
      temporalClient,
      () =>
        temporalClient.workflow.start('RoseDescendantWorkflowStartTombstone', {
          taskQueue: DESCENDANT_START_TOMBSTONE_TASK_QUEUE,
          workflowId,
          args: [workflowId],
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
        }),
      deadlineAtMs
    );
    return {
      workflowId: handle.workflowId,
      firstExecutionRunId: handle.firstExecutionRunId,
    };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    return resolveTemporalWorkflowExecutionRefWithClient(temporalClient, workflowId, deadlineAtMs);
  }
}

export async function claimTemporalWorkflowIdForTermination(
  workflowId: string,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  return claimTemporalWorkflowIdForTerminationWithClient(
    await getTemporalClient(),
    workflowId,
    deadlineAtMs
  );
}

/** Start an agent workflow and retain its immutable Temporal chain identity. */
export async function startAgentWorkflowExecutionWithClient(
  client: Pick<Client, 'withDeadline' | 'workflow'>,
  params: StartAgentWorkflowParams,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  let workflowId = params.workflowId ?? params.agentId;
  const workflowArgs = buildAgentWorkflowArgs(params);

  let execution: TemporalWorkflowExecutionRef;
  let admission: StartAdmission | undefined;
  const admissionDeadline = Math.min(
    deadlineAtMs ?? Number.POSITIVE_INFINITY,
    Date.now() + TEMPORAL_CONTROL_RPC_TIMEOUT_MS
  );
  try {
    const handle = await withTemporalControlDeadline(
      client,
      async () => {
        // Explicit override (descendants inherit the parent's generation queue;
        // tests isolate) wins; otherwise resolve the current cutover generation
        // via the AgentQueuePointer, which falls back to TEMPORAL_TASK_QUEUE when
        // unset. Resolved UNDER the control deadline so a cache-miss Prisma read
        // cannot block the start past the caller's deadline.
        const taskQueue = params.taskQueue || (await getCurrentAgentQueue());
        const fingerprint = createHash('sha256').update(JSON.stringify(workflowArgs)).digest('hex');
        try {
          admission = await claimWorkflowStart(
            params.agentId,
            workflowId,
            taskQueue,
            params.rejectDuplicateWorkflowId === true,
            admissionDeadline,
            undefined,
            fingerprint
          );
        } catch (error) {
          if (!(error instanceof PhysicalRootReconciliationRequired)) throw error;
          const witnesses = new Map<string, RootTerminalWitness>();
          try {
            for (const ref of error.executions) {
              const proof = await observePhysicalRootWitness(ref, async () => {
                const description = await withTemporalControlDeadline(
                  client,
                  () => client.workflow.getHandle(ref.workflowId).describe(),
                  admissionDeadline
                );
                return {
                  firstRunId: description.raw.workflowExecutionInfo?.firstRunId,
                  terminal: nativeWorkflowTerminal(description.status.name),
                };
              });
              witnesses.set(physicalWitnessKey(ref), proof);
            }
          } catch (nativeError) {
            if (nativeError instanceof WorkflowStartAdmissionPendingError) throw nativeError;
            throw new WorkflowStartAdmissionPendingError(
              'Prior physical root reconciliation is pending',
              { cause: nativeError }
            );
          }
          if (error.logicalProbeId) {
            try {
              const description = await withTemporalControlDeadline(
                client,
                () => client.workflow.getHandle(error.logicalProbeId!).describe(),
                admissionDeadline
              );
              const firstExecutionRunId = description.raw.workflowExecutionInfo?.firstRunId;
              if (!firstExecutionRunId || !nativeWorkflowTerminal(description.status.name))
                throw new WorkflowStartAdmissionPendingError(
                  'Legacy logical root is not natively terminal'
                );
              witnesses.set(`logical:${error.logicalProbeId}`, {
                workflowId: error.logicalProbeId,
                firstExecutionRunId,
                status: 'TERMINAL',
              });
            } catch (probeError) {
              if (!(probeError instanceof WorkflowNotFoundError))
                throw new WorkflowStartAdmissionPendingError(
                  'Legacy logical root reconciliation is pending',
                  { cause: probeError }
                );
              witnesses.set(`logical:${error.logicalProbeId}`, {
                workflowId: error.logicalProbeId,
                status: 'ABSENT',
              });
            }
          }
          admission = await claimWorkflowStart(
            params.agentId,
            workflowId,
            taskQueue,
            params.rejectDuplicateWorkflowId === true,
            admissionDeadline,
            undefined,
            fingerprint,
            witnesses
          );
        }
        workflowId = admission.workflowId;
        log.info('Starting agent workflow', { workflowId, taskQueue: admission.queue });
        return client.workflow.start('AgentWorkflow', {
          taskQueue: admission!.queue,
          workflowId,
          args: workflowArgs,
          ...(admission.rejectDuplicate
            ? {
                workflowIdReusePolicy: 'REJECT_DUPLICATE' as const,
                workflowIdConflictPolicy: 'FAIL' as const,
              }
            : {}),
        });
      },
      admissionDeadline
    );
    execution = {
      workflowId: handle.workflowId,
      firstExecutionRunId: handle.firstExecutionRunId,
    };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      if (admission) retainPendingWorkflowStart(error);
      throw error;
    }
    try {
      execution = await resolveTemporalWorkflowExecutionRefWithClient(
        client,
        workflowId,
        admissionDeadline
      );
    } catch (resolveError) {
      if (admission) retainPendingWorkflowStart(resolveError);
      throw resolveError;
    }
  }

  if (admission) {
    try {
      await acknowledgeWorkflowStart(admission, execution, admissionDeadline);
    } catch (error) {
      retainPendingWorkflowStart(error);
      throw error;
    }
  }

  log.info('Workflow started', {
    workflowId: execution.workflowId,
    runId: execution.firstExecutionRunId,
  });

  return execution;
}

export async function startAgentWorkflowExecution(
  params: StartAgentWorkflowParams,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  return startAgentWorkflowExecutionWithClient(await getTemporalClient(), params, deadlineAtMs);
}

/* c8 ignore start -- getWorkflowStatus requires live Temporal server */
/**
 * Get workflow status
 */
export async function getWorkflowStatus(
  workflowId: string
): Promise<{ status: string; runId: string; startTime: Date } | null> {
  const client = await getTemporalClient();

  try {
    const handle = client.workflow.getHandle(workflowId);
    const description = await handle.describe();

    return {
      status: description.status.name,
      runId: description.runId,
      startTime: description.startTime,
    };
  } catch (error) {
    log.error('Failed to get workflow status', { workflowId, error: String(error) });
    return null;
  }
}

/**
 * Reconcile a workflow whose start outcome is AMBIGUOUS.
 *
 * `getWorkflowStatus` collapses "no such workflow" and "the describe call
 * failed" into a single `null`, which is unsafe for a caller deciding whether
 * to mark an agent FAILED: a transient Temporal error would bury a workflow
 * that is actually running. This returns a discriminated result so
 * `lookup_failed` can be treated as "unknown, stay retryable" rather than
 * "absent".
 */
export type WorkflowReconciliation =
  | { kind: 'live'; status: string; runId: string; firstExecutionRunId: string | null }
  | { kind: 'terminal'; status: string }
  | { kind: 'absent' }
  | { kind: 'lookup_failed'; error: string };

const LIVE_WORKFLOW_STATUSES = new Set(['RUNNING', 'CONTINUED_AS_NEW']);

export async function reconcileWorkflowStart(workflowId: string): Promise<WorkflowReconciliation> {
  try {
    const client = await getTemporalClient();
    // Bounded like every other control-plane RPC in this file. This runs on the
    // SMS supervisor commit path, so an unbounded describe() against a wedged
    // Temporal frontend would hang the user's reply rather than degrade. A
    // deadline error falls through to `lookup_failed` below, which callers
    // already treat as "unknown — do not mark the agent FAILED".
    const description = await withTemporalControlDeadline(client, () =>
      client.workflow.getHandle(workflowId).describe()
    );
    const status = description.status.name;
    const firstRunId = description.raw.workflowExecutionInfo?.firstRunId;
    return LIVE_WORKFLOW_STATUSES.has(status)
      ? {
          kind: 'live',
          status,
          runId: description.runId,
          firstExecutionRunId:
            typeof firstRunId === 'string' && firstRunId.length > 0 ? firstRunId : null,
        }
      : { kind: 'terminal', status };
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return { kind: 'absent' };
    return { kind: 'lookup_failed', error: error instanceof Error ? error.message : String(error) };
  }
}
/* c8 ignore stop */
