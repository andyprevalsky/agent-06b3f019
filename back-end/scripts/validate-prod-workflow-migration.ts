#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { type AgentStatus, type Message } from '@prisma/client';
import {
  prepareAgentWorkflowReplacement,
  startPreparedAgentWorkflowReplacement,
  type PreparedAgentWorkflowReplacement,
} from '../src/domains/agents/agentRestartService';
import { prisma } from '../src/providers/database';
import { createMessage } from '../src/providers/messages';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
} from '../src/providers/staleWorkflowTools';
import {
  getTemporalClient,
  startAgentWorkflowExecution,
  type TemporalWorkflowExecutionRef,
} from '../src/providers/temporal';
import { waitForWorkflowReplacementBootstrap } from '../src/providers/workflowDeploymentMigration';

interface ValidationAgent {
  agentId: string;
  staleWorkflowId: string;
  staleExecution: TemporalWorkflowExecutionRef;
}

interface ValidationResult {
  test: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const runId = randomUUID();
const userId = `prod-workflow-migration-validation-${runId}`;
const dormantQueue = `navi-prod-migration-validation-${runId}`;
const results: ValidationResult[] = [];
const workflowIds = new Set<string>();
const agentIds = new Set<string>();

function requireProductionOptIn(): void {
  if (
    !process.argv.includes('--execute') ||
    process.env.PRODUCTION_WORKFLOW_MIGRATION_VALIDATION !== '1'
  ) {
    throw new Error(
      'Production workflow migration validation requires --execute and PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1'
    );
  }
  if (process.env.TEMPORAL_TASK_QUEUE !== 'navi-agent-tasks') {
    throw new Error('Production validation requires TEMPORAL_TASK_QUEUE=navi-agent-tasks');
  }
  for (const variable of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const value = process.env[variable];
    if (!value) throw new Error(`${variable} is required`);
    const hostname = new URL(value).hostname;
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      throw new Error(`Refusing production validation against local ${variable}`);
    }
  }
}

async function check(test: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ test, status: 'PASS', detail: detail ?? 'verified' });
  } catch (error) {
    results.push({
      test,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createDormantAgent(
  status: AgentStatus,
  options: { parentAgentId?: string; verifier?: boolean } = {}
): Promise<ValidationAgent> {
  const agentId = randomUUID();
  const staleWorkflowId = `${agentId}:prod-validation:stale`;
  const staleExecution = await startAgentWorkflowExecution({
    agentId,
    userId,
    goal: 'Production workflow migration validation fixture',
    model: 'rose-labs/rose-1-lite',
    reasoningMaxTokens: 256,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    taskQueue: dormantQueue,
    workflowId: staleWorkflowId,
    parentAgentId: options.parentAgentId,
    parentWorkflowId: options.parentAgentId
      ? `${options.parentAgentId}:prod-validation:stale`
      : undefined,
    depth: options.parentAgentId ? 1 : 0,
    busId: options.parentAgentId ?? agentId,
    startPhase: 'execute',
    maxIterations: 37,
    priceLimitCents: 250,
    contextGates: { network: false, recent_communications: true },
  });
  workflowIds.add(staleWorkflowId);
  agentIds.add(agentId);
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Production workflow migration validation fixture',
      status,
      statusMessage: `Preserve ${status}`,
      progress: 0.4,
      temporalWorkflowId: staleWorkflowId,
      temporalFirstExecutionRunId: staleExecution.firstExecutionRunId,
      parentAgentId: options.parentAgentId,
      depth: options.parentAgentId ? 1 : 0,
      busId: options.parentAgentId ?? agentId,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 256,
      tokenCount: 950,
      tokensIn: 680,
      tokensOut: 270,
      contextSize: 42_000,
      messageCount: 73,
      ownCostCents: 17.25,
      treeCostCents: 29,
      workflowIterationOffset: 12,
      priceLimitCents: 250,
      toolsInUse: ['web_search'],
      responseSchema: { fields: [{ name: 'answer', type: 'string' }] },
      ...(options.verifier === false ? {} : { verifier: { create: {} } }),
    },
  });
  return { agentId, staleWorkflowId, staleExecution };
}

async function addToolMessage(
  agentId: string,
  workflowGeneration: string,
  toolCallId: string,
  toolStatus: string,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<Message> {
  return prisma.message.create({
    data: {
      agentId,
      workflowGeneration,
      role: 'TOOL',
      text,
      metadata: { workflowGeneration, toolCallId, toolName: 'web_search', toolStatus, ...metadata },
    },
  });
}

async function prepare(agent: ValidationAgent): Promise<PreparedAgentWorkflowReplacement> {
  const prepared = await prepareAgentWorkflowReplacement(agent.agentId, undefined, {
    expectedWorkflowId: agent.staleWorkflowId,
    deadlineAtMs: Date.now() + 120_000,
  });
  if (prepared.prepared !== true) {
    throw new Error('error' in prepared ? prepared.error : 'replacement was unexpectedly skipped');
  }
  return prepared;
}

async function startAndReady(prepared: PreparedAgentWorkflowReplacement): Promise<{
  workflowId: string;
  handle: ReturnType<Awaited<ReturnType<typeof getTemporalClient>>['workflow']['getHandle']>;
}> {
  const started = await startPreparedAgentWorkflowReplacement({
    ...prepared,
    deadlineAtMs: Date.now() + 120_000,
  });
  workflowIds.add(started.workflow_id);
  await waitForWorkflowReplacementBootstrap(prepared.agentId, started.workflow_id, {
    timeoutMs: 120_000,
  });
  const client = await getTemporalClient();
  return {
    workflowId: started.workflow_id,
    handle: client.workflow.getHandle(started.workflow_id),
  };
}

async function activityCount(
  handle: ReturnType<Awaited<ReturnType<typeof getTemporalClient>>['workflow']['getHandle']>
) {
  const history = await handle.fetchHistory();
  return {
    activities:
      history.events?.filter((event) => event.activityTaskScheduledEventAttributes !== undefined)
        .length ?? 0,
    markers:
      history.events?.filter((event) => event.markerRecordedEventAttributes !== undefined).length ??
      0,
    workflowTaskFailures:
      history.events?.filter((event) => event.workflowTaskFailedEventAttributes !== undefined)
        .length ?? 0,
  };
}

async function main(): Promise<void> {
  requireProductionOptIn();
  const root = await createDormantAgent('PAUSED');
  const child = await createDormantAgent('PAUSED', { parentAgentId: root.agentId });
  const unresolvedCall = randomUUID();
  const resolvedCall = randomUUID();
  const approvalCall = randomUUID();
  const childCall = randomUUID();
  const attentionRequestId = randomUUID();
  await addToolMessage(root.agentId, root.staleWorkflowId, unresolvedCall, 'IN_PROGRESS', '');
  await addToolMessage(root.agentId, root.staleWorkflowId, resolvedCall, 'IN_PROGRESS', '');
  await addToolMessage(
    root.agentId,
    root.staleWorkflowId,
    resolvedCall,
    'FINISHED',
    'success before seal'
  );
  await addToolMessage(root.agentId, root.staleWorkflowId, approvalCall, 'IN_PROGRESS', '', {
    toolName: 'request_user_approval',
    attentionRequestId,
  });
  await addToolMessage(child.agentId, child.staleWorkflowId, childCall, 'IN_PROGRESS', '');
  await prisma.agentAttentionRequest.create({
    data: {
      id: attentionRequestId,
      userId,
      agentId: root.agentId,
      workflowId: root.staleWorkflowId,
      question: 'Approve the stale production validation action?',
    },
  });

  let preparedRoot: PreparedAgentWorkflowReplacement | undefined;
  await check('paused_state_snapshot', async () => {
    preparedRoot = await prepare(root);
    const state = preparedRoot.claim.resumeState;
    assert.strictEqual(state.prior_status, 'PAUSED');
    assert.strictEqual(state.token_count, 950);
    assert.strictEqual(state.context_size, 42_000);
    assert.strictEqual(state.message_count, 73);
    assert.strictEqual(state.iteration_offset, 12);
    assert.strictEqual(state.max_iterations, 37);
    assert.deepStrictEqual(state.context_gates, { network: false, recent_communications: true });
    return 'pause, counters, iteration budget, and historical config preserved';
  });
  await check('in_progress_tool_terminalized_once', async () => {
    assert(preparedRoot);
    await finalizeInterruptedWorkflowTools(root.agentId, root.staleWorkflowId);
    const rows = await prisma.message.findMany({
      where: { agentId: root.agentId, metadata: { path: ['toolCallId'], equals: unresolvedCall } },
    });
    const terminals = rows.filter(
      (row) => (row.metadata as Record<string, unknown> | null)?.toolStatus === 'FINISHED'
    );
    assert.strictEqual(terminals.length, 1);
    assert.strictEqual(terminals[0].text, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    return 'exactly one deployment error appended';
  });
  await check('success_before_seal_wins', async () => {
    const rows = await prisma.message.findMany({
      where: { agentId: root.agentId, metadata: { path: ['toolCallId'], equals: resolvedCall } },
      orderBy: { createdAt: 'asc' },
    });
    assert.strictEqual(
      rows.filter((row) => row.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE).length,
      0
    );
    assert.strictEqual(rows.at(-1)?.text, 'success before seal');
  });
  await check('late_stale_success_becomes_deployment_error', async () => {
    const late = await createMessage({
      agentId: root.agentId,
      workflowGeneration: root.staleWorkflowId,
      enforceCurrentWorkflowGeneration: true,
      role: 'TOOL',
      text: 'late success',
      metadata: {
        workflowGeneration: root.staleWorkflowId,
        toolCallId: unresolvedCall,
        toolName: 'web_search',
        toolStatus: 'FINISHED',
      },
    });
    assert.strictEqual(late.text, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
  });
  await check('approval_wait_closed_for_llm_retry', async () => {
    const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
      where: { id: attentionRequestId },
    });
    assert.strictEqual(request.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
  });
  await check('descendant_terminated_and_failed', async () => {
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: child.agentId } });
    assert.strictEqual(stored.status, 'FAILED');
    assert.strictEqual(stored.statusMessage, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    const client = await getTemporalClient();
    const description = await client.workflow.getHandle(child.staleWorkflowId).describe();
    assert.strictEqual(description.status.name, 'TERMINATED');
    const toolRows = await prisma.message.findMany({
      where: { agentId: child.agentId, metadata: { path: ['toolCallId'], equals: childCall } },
    });
    const deploymentErrors = toolRows.filter(
      (row) =>
        row.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE &&
        (row.metadata as Record<string, unknown> | null)?.toolStatus === 'FINISHED'
    );
    assert.strictEqual(deploymentErrors.length, 1);
    return 'child execution terminated, row failed, and child tool terminalized once';
  });

  let pausedHandle: Awaited<ReturnType<typeof startAndReady>> | undefined;
  await check('candidate_bootstrap_durable_ready', async () => {
    assert(preparedRoot);
    pausedHandle = await startAndReady(preparedRoot);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: root.agentId } });
    assert.strictEqual(stored.workflowReplacementToken, null);
    assert.strictEqual(stored.status, 'PAUSED');
    assert.strictEqual(stored.temporalWorkflowId, pausedHandle.workflowId);
    assert.strictEqual(await pausedHandle.handle.query('is_paused_query'), true);
    return 'restored DB state persisted before claim cleared';
  });
  await check('cold_workflow_uses_no_resources_while_waiting', async () => {
    assert(pausedHandle);
    const before = await activityCount(pausedHandle.handle);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const after = await activityCount(pausedHandle.handle);
    assert.strictEqual(after.activities, before.activities);
    return `${after.activities} bootstrap activities; zero growth while paused`;
  });
  await check('fresh_history_has_no_patch_or_nondeterminism', async () => {
    assert(pausedHandle);
    const counts = await activityCount(pausedHandle.handle);
    assert.strictEqual(counts.markers, 0);
    assert.strictEqual(counts.workflowTaskFailures, 0);
  });

  for (const status of ['COST_LIMIT_REACHED', 'OUT_OF_CREDITS'] as const) {
    await check(`${status.toLowerCase()}_preserved`, async () => {
      const fixture = await createDormantAgent(status);
      const replacement = await prepare(fixture);
      assert.strictEqual(replacement.claim.resumeState.prior_status, status);
      const ready = await startAndReady(replacement);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
      assert.strictEqual(stored.status, status);
      assert.strictEqual(await ready.handle.query('is_paused_query'), true);
      assert.strictEqual(
        await ready.handle.query('is_cost_limit_reached_query'),
        status === 'COST_LIMIT_REACHED'
      );
      const before = await activityCount(ready.handle);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.deepStrictEqual(await activityCount(ready.handle), before);
    });
  }

  await check('pause_race_after_active_snapshot_wins', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    const replacement = await prepare(fixture);
    await prisma.agent.update({ where: { id: fixture.agentId }, data: { status: 'PAUSED' } });
    const ready = await startAndReady(replacement);
    assert.strictEqual(await ready.handle.query('is_paused_query'), true);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })).status,
      'PAUSED'
    );
  });

  await check('malformed_root_fails_closed', async () => {
    const fixture = await createDormantAgent('PAUSED', { verifier: false });
    const replacement = await prepareAgentWorkflowReplacement(fixture.agentId, undefined, {
      expectedWorkflowId: fixture.staleWorkflowId,
    });
    assert('error' in replacement);
    assert.match(replacement.error, /no verifier/);
  });
}

async function cleanup(): Promise<void> {
  const client = await getTemporalClient();
  for (const workflowId of workflowIds) {
    try {
      await client.workflow
        .getHandle(workflowId)
        .terminate('Production migration validation cleanup');
    } catch {
      // Closed/terminated workflows need no cleanup.
    }
  }
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
  const rows = await prisma.agent.findMany({
    where: { id: { in: [...agentIds] } },
    orderBy: { depth: 'desc' },
    select: { id: true },
  });
  for (const row of rows) await prisma.agent.deleteMany({ where: { id: row.id } });
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
    } catch (error) {
      results.push({
        test: 'fixture_cleanup',
        status: 'FAIL',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
    process.stdout.write(`${JSON.stringify({ runId, results }, null, 2)}\n`);
    await prisma.$disconnect();
    if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
  });
