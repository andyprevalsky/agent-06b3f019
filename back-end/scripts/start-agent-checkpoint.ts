#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { startAgentWorkflowExecution } from '../src/providers/temporal';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';

type Options = {
  agentId: string;
  taskQueue?: string;
  startPhase: 'execute' | 'execute_dag_resume';
};

const prisma = new PrismaClient();

function usage(): never {
  console.log(`usage: npx tsx scripts/start-agent-checkpoint.ts --agent-id UUID [options]

Start an existing no-start checkpoint at AgentWorkflow execute_dag_resume
(or --start-phase execute for a post-completion chat re-escalation replay).

Options:
  --task-queue NAME   Temporal task queue. Defaults to TEMPORAL_TASK_QUEUE.
  --start-phase execute|execute_dag_resume
                      Default execute_dag_resume.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { agentId: '', startPhase: 'execute_dag_resume' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--agent-id') opts.agentId = next();
    else if (arg === '--task-queue') opts.taskQueue = next();
    else if (arg === '--start-phase') {
      const value = next();
      if (value !== 'execute' && value !== 'execute_dag_resume') {
        throw new Error('--start-phase must be execute or execute_dag_resume');
      }
      opts.startPhase = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.agentId) throw new Error('--agent-id is required');
  return opts;
}

function assertLocalDatabase() {
  if (process.env.ALLOW_PROD_CHECKPOINT_CLONE === 'true') return;
  const reason = nonLocalDatabaseReason(process.env.DATABASE_URL);
  if (reason) {
    throw new Error(
      `Refusing to start checkpoint: ${reason}. ` +
        'Set ALLOW_PROD_CHECKPOINT_CLONE=true only if you intend this.'
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertLocalDatabase();

  const taskQueue = opts.taskQueue || process.env.TEMPORAL_TASK_QUEUE;
  if (!taskQueue) throw new Error('TEMPORAL_TASK_QUEUE is required');

  const agent = await prisma.agent.findUnique({
    where: { id: opts.agentId },
    include: { verifier: true },
  });
  if (!agent) throw new Error(`Agent not found: ${opts.agentId}`);
  if (agent.status !== 'PAUSED') {
    throw new Error(`Expected checkpoint agent ${opts.agentId} to be PAUSED, got ${agent.status}`);
  }
  if (agent.parentAgentId) {
    throw new Error(`Expected root checkpoint agent, got child agent ${opts.agentId}`);
  }

  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      status: 'ACTIVE',
      temporalWorkflowId: agent.id,
    },
  });

  const execution = await startAgentWorkflowExecution({
    agentId: agent.id,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: { type: agent.verifier?.type || 'FLOAT_LLM_JUDGE' },
    taskQueue,
    busId: agent.busId || agent.id,
    startPhase: opts.startPhase as any,
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
  });
  await prisma.agent.updateMany({
    where: { id: agent.id, temporalWorkflowId: execution.workflowId },
    data: { temporalFirstExecutionRunId: execution.firstExecutionRunId },
  });
  const workflowId = execution.workflowId;

  console.log(`agent_id=${agent.id}`);
  console.log(`workflow_id=${workflowId}`);
  console.log(`start_phase=${opts.startPhase}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
