#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../src/providers/database';
import { getTemporalClient, startAgentWorkflowExecution } from '../src/providers/temporal';
import {
  acquireWorkflowDeploymentLease,
  type WorkflowDeploymentLease,
} from '../src/providers/workflowDeploymentLease';
import type { WorkflowResumeState } from '../src/providers/workflowReplacementState';

interface ValidationResult {
  test: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const runId = randomUUID();
const agentId = randomUUID();
const userId = `candidate-workflow-validation-${runId}`;
const workflowId = `${agentId}:candidate-image:${runId}`;
const results: ValidationResult[] = [];
let lease: WorkflowDeploymentLease | null = null;
let workflowStarted = false;

function requireProductionOptIn(): string {
  if (
    !process.argv.includes('--execute') ||
    process.env.PRODUCTION_WORKFLOW_MIGRATION_VALIDATION !== '1'
  ) {
    throw new Error(
      'Candidate image validation requires --execute and PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1'
    );
  }
  const deploymentToken = process.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN;
  const taskQueue = process.env.TEMPORAL_CANDIDATE_VALIDATION_TASK_QUEUE;
  if (!deploymentToken || !taskQueue) {
    throw new Error(
      'TEMPORAL_WORKER_DEPLOYMENT_TOKEN and TEMPORAL_CANDIDATE_VALIDATION_TASK_QUEUE are required'
    );
  }
  if (taskQueue !== `navi-agent-candidate-${deploymentToken}`) {
    throw new Error('Candidate validation queue does not match the exact deployment attempt');
  }
  if (process.env.TEMPORAL_TASK_QUEUE !== 'navi-agent-tasks') {
    throw new Error('Production validation requires TEMPORAL_TASK_QUEUE=navi-agent-tasks');
  }
  for (const variable of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const value = process.env[variable];
    if (!value) throw new Error(`${variable} is required`);
    if (['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname)) {
      throw new Error(`Refusing production validation against local ${variable}`);
    }
  }
  return taskQueue;
}

async function check(test: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ test, status: 'PASS', detail: await fn() });
  } catch (error) {
    results.push({
      test,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function validationResumeState(): WorkflowResumeState {
  return {
    version: 1,
    kind: 'validation',
    prior_status: 'ACTIVE',
    prior_status_message: 'Candidate image validation',
    progress: 0.25,
    token_count: 321,
    tokens_in: 200,
    tokens_out: 121,
    tree_tokens_in: 200,
    tree_tokens_out: 121,
    context_size: 12_345,
    message_count: 7,
    workflow_started_at: new Date(Date.now() - 60_000).toISOString(),
    own_cost_cents: 1.5,
    subtree_cost_cents: 1.5,
    children_cost_cents: {},
    children_tokens_in: {},
    children_tokens_out: {},
    child_last_tokens: {},
    child_tool_counts: {},
    iteration_offset: 4,
    max_iterations: 20,
    context_gates: {
      authenticated_sessions: false,
      integrations: false,
      recent_communications: false,
      network: false,
      shared_files: false,
      custom_system_prompt: false,
    },
    runtime_state: { deployment_validation: true },
  };
}

async function waitUntilInitialized(): Promise<void> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if (await handle.query<boolean>('deployment_initialized_query')) return;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) {
        const description = await handle.describe();
        if (description.status.name !== 'RUNNING') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Candidate workflow did not reach the pre-LLM initialization boundary');
}

async function main(): Promise<void> {
  const taskQueue = requireProductionOptIn();
  lease = await acquireWorkflowDeploymentLease();
  await prisma.user.create({
    data: {
      userId,
      isAnonymous: true,
      credits: { create: { amountCents: 100_000 } },
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Initialize the exact candidate worker image without entering the LLM loop',
      status: 'ACTIVE',
      statusMessage: 'Candidate image validation',
      progress: 0.25,
      temporalWorkflowId: workflowId,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 256,
      tokenCount: 321,
      tokensIn: 200,
      tokensOut: 121,
      contextSize: 12_345,
      messageCount: 7,
      ownCostCents: 1.5,
      treeCostCents: 2,
      workflowIterationOffset: 4,
      priceLimitCents: 1_000,
      responseSchema: { fields: [{ name: 'answer', type: 'string', required: true }] },
      verifier: { create: {} },
    },
  });

  const execution = await startAgentWorkflowExecution({
    agentId,
    userId,
    goal: 'Initialize the exact candidate worker image without entering the LLM loop',
    model: 'rose-labs/rose-1-lite',
    reasoningMaxTokens: 256,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    taskQueue,
    workflowId,
    startPhase: 'resume',
    maxIterations: 20,
    priceLimitCents: 1_000,
    contextGates: validationResumeState().context_gates ?? undefined,
    resumeState: validationResumeState(),
    rejectDuplicateWorkflowId: true,
  });
  workflowStarted = true;
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalFirstExecutionRunId: execution.firstExecutionRunId },
  });

  await check('candidate_image_initializes_before_activation', async () => {
    await waitUntilInitialized();
    return `exact deployment queue ${taskQueue} reached the pre-LLM boundary`;
  });
  await check('candidate_history_is_deterministic', async () => {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    const history = await handle.fetchHistory();
    const failures =
      history.events?.filter((event) => Boolean(event.workflowTaskFailedEventAttributes)) ?? [];
    const activities =
      history.events?.filter((event) => Boolean(event.activityTaskScheduledEventAttributes))
        .length ?? 0;
    assert.strictEqual(failures.length, 0);
    assert(activities > 0, 'candidate workflow did not execute common initialization activities');
    assert.strictEqual((await handle.describe()).status.name, 'RUNNING');
    return `${activities} initialization activities, zero workflow-task failures`;
  });
  await check('candidate_restores_durable_state_without_llm_work', async () => {
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.strictEqual(stored.status, 'ACTIVE');
    assert.strictEqual(stored.tokenCount, 321);
    assert.strictEqual(stored.tokensIn, 200);
    assert.strictEqual(stored.tokensOut, 121);
    assert.strictEqual(stored.contextSize, 12_345);
    assert.strictEqual(stored.messageCount, 7);
    assert.strictEqual(stored.workflowIterationOffset, 4);
    assert.strictEqual(await prisma.toolUsage.count({ where: { agentId } }), 0);
    return 'status, counters, context, and iteration restored; zero tool/LLM usage rows';
  });
}

async function cleanup(): Promise<void> {
  if (workflowStarted) {
    try {
      const client = await getTemporalClient();
      await client.workflow.getHandle(workflowId).terminate('Candidate image validation complete');
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  }
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { userId } });
  assert.strictEqual(await prisma.agent.count({ where: { id: agentId } }), 0);
  assert.strictEqual(await prisma.user.count({ where: { userId } }), 0);
}

main()
  .catch((error) => {
    results.push({
      test: 'harness_execution',
      status: 'FAIL',
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  })
  .finally(async () => {
    try {
      await cleanup();
      results.push({
        test: 'candidate_fixture_cleanup',
        status: 'PASS',
        detail: 'synthetic workflow and database rows removed',
      });
    } catch (error) {
      results.push({
        test: 'candidate_fixture_cleanup',
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (lease !== null) {
      try {
        await lease.release();
      } catch (error) {
        results.push({
          test: 'deployment_lease_release',
          status: 'FAIL',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    process.stdout.write(`${JSON.stringify({ runId, results }, null, 2)}\n`);
    await prisma.$disconnect();
    if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
  });
