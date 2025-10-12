import { Connection, Client } from '@temporalio/client';

let client: Client | null = null;

/**
 * Get or create a Temporal client connected to Temporal Cloud
 */
export async function getTemporalClient(): Promise<Client> {
  if (client) {
    return client;
  }

  const address = process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'quickstart-navi.lqjlv';
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!apiKey) {
    throw new Error('Missing TEMPORAL_API_KEY environment variable');
  }

  console.log('🔗 Connecting to Temporal Cloud...', {
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

  console.log('✅ Connected to Temporal Cloud');

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
  reasoningEffort: string;
  toolIds: string[];
  verifier: {
    type: string;
    llmJudgePrompt: string;
  };
  taskQueue?: string; // Optional: override task queue (for testing isolation)
}): Promise<string> {
  const client = await getTemporalClient();
  // Use provided task queue or default to environment-specific queue
  const taskQueue = params.taskQueue || process.env.TEMPORAL_TASK_QUEUE || 'navi-agent-tasks';
  const workflowId = params.agentId;

  console.log('🚀 Starting agent workflow', {
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
      params.reasoningEffort,
      params.toolIds,
      {
        type: params.verifier.type,
        llmJudgePrompt: params.verifier.llmJudgePrompt,
      },
      [], // Start with empty context, workflow will poll for goal message
    ],
  });

  console.log('✅ Workflow started', {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  });

  return handle.workflowId;
}


/**
 * Get workflow status
 */
export async function getWorkflowStatus(workflowId: string): Promise<any> {
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
    console.error('Failed to get workflow status', { workflowId, error });
    return null;
  }
}

