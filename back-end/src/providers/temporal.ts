import {
  Connection,
  Client,
  defaultPayloadConverter,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { createLogger } from './logger';
import type { WorkflowLaunchConfig, WorkflowResumeState } from './workflowReplacementState';

const log = createLogger('Temporal');

let client: Client | null = null;

/**
 * Get or create a Temporal client connected to Temporal Cloud
 */
export async function getTemporalClient(): Promise<Client> {
  if (client) {
    return client;
  }

  const address = process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!namespace) {
    throw new Error('Missing TEMPORAL_NAMESPACE environment variable');
  }

  if (!apiKey) {
    throw new Error('Missing TEMPORAL_API_KEY environment variable');
  }

  log.info('Connecting to Temporal Cloud...', {
    address,
    namespace,
  });

  const connection = await Connection.connect({
    address,
    tls: true, // Required for Temporal Cloud
    apiKey, // Use apiKey directly (simpler than metadata)
  });

  client = new Client({
    connection,
    namespace,
  });

  log.info('Connected to Temporal Cloud');

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
  startPhase?: 'plan' | 'execute' | 'resume'; // 'resume' is internal deployment recovery
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
  fastModeCacheEnabled?: boolean; // Optional: Fast Mode aggressive cache (own flag, not a gate)
  workflowId?: string; // Optional preclaimed generation-specific workflow ID
  resumeState?: WorkflowResumeState; // Durable state captured before deployment replacement
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
  workflowId: string
): Promise<WorkflowLaunchConfig> {
  const temporalClient = await getTemporalClient();
  let response;
  try {
    response = await temporalClient.withDeadline(Date.now() + 10_000, () =>
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
    params.fastModeCacheEnabled ?? false,
  ];
  // Keep ordinary starts compatible with the previous 16-argument worker.
  // Only a candidate worker handling a deployment replacement receives #17.
  if (params.resumeState !== undefined) args.push(params.resumeState);
  return args;
}

/** Resolve the immutable chain identity for an already-started workflow. */
export async function resolveTemporalWorkflowExecutionRef(
  workflowId: string
): Promise<TemporalWorkflowExecutionRef> {
  const temporalClient = await getTemporalClient();
  const description = await temporalClient.workflow.getHandle(workflowId).describe();
  const firstExecutionRunId = description.raw.workflowExecutionInfo?.firstRunId;
  if (typeof firstExecutionRunId !== 'string' || firstExecutionRunId.length === 0) {
    throw new Error(`Temporal did not return a first execution run ID for ${workflowId}`);
  }
  return { workflowId, firstExecutionRunId };
}

/** Start an agent workflow and retain its immutable Temporal chain identity. */
export async function startAgentWorkflowExecution(
  params: StartAgentWorkflowParams
): Promise<TemporalWorkflowExecutionRef> {
  const client = await getTemporalClient();
  // Use provided task queue or default to environment-specific queue
  const taskQueue = params.taskQueue || process.env.TEMPORAL_TASK_QUEUE;
  if (!taskQueue) {
    throw new Error(
      'TEMPORAL_TASK_QUEUE is not set — run.sh must derive it from CONDUCTOR_WORKSPACE_NAME'
    );
  }
  const workflowId = params.workflowId ?? params.agentId;

  log.info('Starting agent workflow', {
    workflowId,
    taskQueue,
  });

  let execution: TemporalWorkflowExecutionRef;
  try {
    const handle = await client.workflow.start('AgentWorkflow', {
      taskQueue,
      workflowId,
      args: buildAgentWorkflowArgs(params),
    });
    execution = {
      workflowId: handle.workflowId,
      firstExecutionRunId: handle.firstExecutionRunId,
    };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    execution = await resolveTemporalWorkflowExecutionRef(workflowId);
  }

  log.info('Workflow started', {
    workflowId: execution.workflowId,
    runId: execution.firstExecutionRunId,
  });

  return execution;
}

/** Backwards-compatible helper for callers that only expose Workflow ID. */
export async function startAgentWorkflow(params: StartAgentWorkflowParams): Promise<string> {
  return (await startAgentWorkflowExecution(params)).workflowId;
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
/* c8 ignore stop */
