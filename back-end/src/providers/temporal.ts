import { Connection, Client } from '@temporalio/client';
import { createLogger } from './logger';

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

/**
 * Start an agent workflow
 */
export async function startAgentWorkflow(params: {
  agentId: string;
  userId: string;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  verifier: {
    type: string;
    llmJudgePrompt: string;
  };
  taskQueue?: string; // Optional: override task queue (for testing isolation)
  parentWorkflowId?: string; // Optional: parent workflow ID for sub-agents
  parentAgentId?: string; // Optional: parent agent ID for tree structure
  depth?: number; // Optional: nesting depth
  busId?: string; // Optional: shared bus channel ID for sub-agent tree updates
  startPhase?: 'plan' | 'execute'; // Optional: 'plan' (default) runs PLAN→EXECUTE, 'execute' skips PLAN
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
}): Promise<string> {
  const client = await getTemporalClient();
  // Use provided task queue or default to environment-specific queue
  const taskQueue = params.taskQueue || process.env.TEMPORAL_TASK_QUEUE || 'navi-agent-tasks';
  const workflowId = params.agentId;

  log.info('Starting agent workflow', {
    workflowId,
    taskQueue,
  });

  const handle = await client.workflow.start('AgentWorkflow', {
    taskQueue,
    workflowId,
    args: [
      params.agentId,
      params.userId,
      params.goal,
      params.model,
      params.reasoningMaxTokens,
      {
        type: params.verifier.type,
        llmJudgePrompt: params.verifier.llmJudgePrompt,
      },
      [], // Start with empty context, workflow will poll for goal message
      params.parentWorkflowId || null, // Parent workflow ID for signaling
      params.parentAgentId || null, // Parent agent ID for tree structure
      params.depth || 0, // Nesting depth
      params.busId || null, // Shared bus channel ID for tree updates
      params.startPhase || 'plan', // Starting phase: 'plan' runs PLAN→EXECUTE, 'execute' skips PLAN
      params.maxIterations || null, // Step limit for execute phase (sub-agents use 25)
      params.priceLimitCents || 100, // Price limit in cents (default $1.00)
      params.contextGates || null, // Context gates: which user context sections to include
    ],
  });

  log.info('Workflow started', {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  });

  return handle.workflowId;
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
