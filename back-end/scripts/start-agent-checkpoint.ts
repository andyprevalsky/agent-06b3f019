#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { startAgentWorkflow } from '../src/providers/temporal';

type Options = {
  agentId: string;
  taskQueue?: string;
};

const prisma = new PrismaClient();

function usage(): never {
  console.log(`usage: npx tsx scripts/start-agent-checkpoint.ts --agent-id UUID [options]

Start an existing no-start checkpoint at AgentWorkflow execute_dag_resume.

Options:
  --task-queue NAME   Temporal task queue. Defaults to TEMPORAL_TASK_QUEUE.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { agentId: '' };
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
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.agentId) throw new Error('--agent-id is required');
  return opts;
}

function assertLocalDatabase() {
  if (process.env.ALLOW_PROD_CHECKPOINT_CLONE === 'true') return;
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  let host = '';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `Refusing to start checkpoint from non-local database host "${host}". ` +
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

  const workflowId = await startAgentWorkflow({
    agentId: agent.id,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: { type: agent.verifier?.type || 'FLOAT_LLM_JUDGE' },
    taskQueue,
    busId: agent.busId || agent.id,
    startPhase: 'execute_dag_resume' as any,
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
  });

  console.log(`agent_id=${agent.id}`);
  console.log(`workflow_id=${workflowId}`);
  console.log('start_phase=execute_dag_resume');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
