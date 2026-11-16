#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { type AgentStatus, type Message } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import {
  acceptStartedWorkflowReplacement,
  finalizeWorkflowReplacementBootstrap,
  prepareAgentWorkflowReplacement,
  startPreparedAgentWorkflowReplacement,
  type PreparedAgentWorkflowReplacement,
} from '../src/domains/agents/agentRestartService';
import { preflightAgentWorkflowReplacement } from '../src/domains/agents/agentRestartPreflight';
import { updateAgentConfigMutation } from '../src/domains/agents/repoWorkflowMutations';
import { prisma } from '../src/providers/database';
import { createMessage } from '../src/providers/messages';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
} from '../src/providers/staleWorkflowTools';
import { saveToolUsage } from '../src/domains/tool-usage/service';
import {
  drainPendingDescendantWorkflowStarts,
  reconcileStartedDescendantWorkflow,
} from '../src/providers/descendantWorkflowStart';
import {
  activateTemporalWorkerBuild,
  cleanupSupersededWorkerActivationMarkers,
  getTemporalClient,
  startAgentWorkflowExecution,
  type TemporalWorkflowExecutionRef,
} from '../src/providers/temporal';
import {
  sameWorkflowHistoryMetrics,
  summarizeWorkflowHistory,
  type WorkflowHistoryMetrics,
} from '../src/providers/workflowHistoryMetrics';
import {
  runWorkflowDeploymentCutover,
  waitForWorkflowReplacementBootstrap,
} from '../src/providers/workflowDeploymentMigration';
import { resolveAndSignal } from '../src/providers/gateResolution';
import {
  recordWorkflowReplacementStartAcceptance,
  recordWorkflowResumeIntent,
} from '../src/providers/workflowReplacementState';
import { resumeAgentWorkflow } from '../src/providers/agentResume';
import { cleanupTerminalAgentWorkflowZombies } from '../src/providers/workflowTerminalCleanup';
import {
  acquireWorkflowDeploymentLease,
  WorkflowDeploymentLeaseBusyError,
  type WorkflowDeploymentLease,
} from '../src/providers/workflowDeploymentLease';

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
const productionUrl = 'https://navi-j9a9.onrender.com';
const CHECK_TIMEOUT_MS = 180_000;
const DEPLOYMENT_LEASE_WAIT_MS = 10 * 60_000;
let deploymentLease: WorkflowDeploymentLease | null = null;

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function acquireProductionDeploymentLease(): Promise<WorkflowDeploymentLease> {
  const deadline = Date.now() + DEPLOYMENT_LEASE_WAIT_MS;
  let lastHolder = 'no contention observed';
  do {
    try {
      return await acquireWorkflowDeploymentLease({ purpose: 'validate-prod-workflow-migration' });
    } catch (error) {
      if (!(error instanceof WorkflowDeploymentLeaseBusyError)) throw error;
      if (error.holderDescription !== lastHolder) {
        process.stderr.write(
          `[WorkflowMigrationValidation] cutover lease busy: ${error.message}\n`
        );
      }
      lastHolder = error.holderDescription;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out after ${DEPLOYMENT_LEASE_WAIT_MS}ms waiting for the production cutover lease; current holder: ${lastHolder}`
  );
}

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
  for (const variable of [
    'BACKEND_API_KEY',
    'TEMPORAL_WORKER_BUILD_ID',
    'TEMPORAL_WORKER_DEPLOYMENT_TOKEN',
  ] as const) {
    if (!process.env[variable]) throw new Error(`${variable} is required`);
  }
}

async function check(test: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await withTimeout(test, fn(), CHECK_TIMEOUT_MS);
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
    model: 'rose-labs/rose-1-flash',
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
      parentWorkflowId: options.parentAgentId
        ? `${options.parentAgentId}:prod-validation:stale`
        : undefined,
      depth: options.parentAgentId ? 1 : 0,
      busId: options.parentAgentId ?? agentId,
      model: 'rose-labs/rose-1-flash',
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

async function createPendingChild(params: {
  parentAgentId: string;
  parentWorkflowId: string;
  depth?: number;
}): Promise<string> {
  const agentId = randomUUID();
  agentIds.add(agentId);
  workflowIds.add(agentId);
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Production pending descendant start validation fixture',
      status: 'STARTING_UP',
      temporalWorkflowId: agentId,
      parentAgentId: params.parentAgentId,
      parentWorkflowId: params.parentWorkflowId,
      depth: params.depth ?? 1,
      busId: params.parentAgentId,
      model: 'rose-labs/rose-1-flash',
      reasoningMaxTokens: 256,
      priceLimitCents: 100,
      responseSchema: { fields: [{ name: 'answer', type: 'string', required: true }] },
      workflowStartPhase: 'execute',
      workflowTaskQueue: dormantQueue,
      workflowMaxIterations: 25,
      workflowContextGates: { network: false },
      verifier: { create: {} },
    },
  });
  return agentId;
}

async function startDormantChild(
  agentId: string,
  parentAgentId: string,
  parentWorkflowId: string
): Promise<TemporalWorkflowExecutionRef> {
  return startAgentWorkflowExecution({
    agentId,
    userId,
    goal: 'Production pending descendant start validation fixture',
    model: 'rose-labs/rose-1-flash',
    reasoningMaxTokens: 256,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    taskQueue: dormantQueue,
    parentAgentId,
    parentWorkflowId,
    depth: 1,
    busId: parentAgentId,
    startPhase: 'execute',
    maxIterations: 25,
    priceLimitCents: 100,
    contextGates: { network: false },
    rejectDuplicateWorkflowId: true,
  });
}

async function sealValidationParent(parent: ValidationAgent): Promise<void> {
  await prisma.agent.update({
    where: { id: parent.agentId },
    data: { temporalWorkflowId: `${parent.agentId}:prod-validation:replacement` },
  });
}

async function assertTerminated(workflowId: string): Promise<void> {
  const client = await getTemporalClient();
  const description = await client.workflow.getHandle(workflowId).describe();
  assert.strictEqual(description.status.name, 'TERMINATED');
}

function assertSameInstant(actual: unknown, expected: Date): void {
  assert.strictEqual(typeof actual, 'string');
  assert.strictEqual(new Date(actual).getTime(), expected.getTime());
}

async function postProductionAgent(
  path: string,
  body: unknown
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${productionUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.BACKEND_API_KEY!,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: responseBody };
}

function childRequest(
  parent: ValidationAgent,
  agentId = randomUUID(),
  goal = 'Production immutable descendant retry fixture'
) {
  agentIds.add(agentId);
  workflowIds.add(agentId);
  return {
    agent_id: agentId,
    user_id: userId,
    goal,
    model: 'rose-labs/rose-1-flash',
    reasoning_max_tokens: 256,
    source: 'WEB',
    start_phase: 'execute',
    task_queue: dormantQueue,
    parent_agent_id: parent.agentId,
    parent_workflow_id: parent.staleWorkflowId,
    depth: 1,
    bus_id: parent.agentId,
    max_iterations: 25,
    price_limit_cents: 100,
    context_gates: { network: false },
    response_schema: {
      fields: [{ name: 'answer', type: 'str', required: true }],
    },
  };
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
    requireInitialized: true,
  });
  const client = await getTemporalClient();
  return {
    workflowId: started.workflow_id,
    handle: client.workflow.getHandle(started.workflow_id),
  };
}

async function activityCount(
  handle: ReturnType<Awaited<ReturnType<typeof getTemporalClient>>['workflow']['getHandle']>
): Promise<WorkflowHistoryMetrics> {
  const history = await handle.fetchHistory();
  const events = history.events ?? [];
  const metrics = summarizeWorkflowHistory(events);
  // Ignore protobuf null placeholders; count only real workflow-task failures.
  const workflowTaskFailures = events.filter(
    (event) => event.workflowTaskFailedEventAttributes != null
  ).length;
  assert.strictEqual(workflowTaskFailures, metrics.workflowTaskFailures);
  return metrics;
}

/**
 * Cooperative cutover parks restored PAUSED / COST_LIMIT / OUT_OF_CREDITS agents
 * in `_wait_for_unpause_or_handoff`: one pointer activity + a 30s wait_condition
 * timer per poll cycle. READY can land before that first timer is scheduled, so
 * a naive before/after sample races the handoff arming. Settle until an *active*
 * handoff timer is present (started, not yet fired/canceled) and history stops
 * moving, then prove no further growth inside the poll window (no LLM/tool burn
 * while cold).
 */
async function assertColdHandoffHistoryStable(
  handle: ReturnType<Awaited<ReturnType<typeof getTemporalClient>>['workflow']['getHandle']>,
  { settleMs = 8_000, observeMs = 2_000 }: { settleMs?: number; observeMs?: number } = {}
): Promise<WorkflowHistoryMetrics> {
  const settleDeadline = Date.now() + settleMs;
  let last = await activityCount(handle);
  while (Date.now() < settleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await activityCount(handle);
    if (sameWorkflowHistoryMetrics(next, last) && next.activeTimers >= 1) {
      last = next;
      break;
    }
    last = next;
  }
  assert.ok(
    last.activeTimers >= 1,
    `expected armed cooperative handoff wait timer while cold-paused; got ${JSON.stringify(last)}`
  );
  await new Promise((resolve) => setTimeout(resolve, observeMs));
  const after = await activityCount(handle);
  assert.deepStrictEqual(after, last);
  return after;
}

async function main(): Promise<void> {
  requireProductionOptIn();
  deploymentLease = await acquireProductionDeploymentLease();
  const root = await createDormantAgent('PAUSED');
  const child = await createDormantAgent('PAUSED', { parentAgentId: root.agentId });
  await prisma.toolUsage.createMany({
    data: [root.agentId, child.agentId].map((agentId) => ({
      operationKey: `prod-validation:${runId}:${agentId}:initial-accounting`,
      agentId,
      userId,
      toolName: 'execute_loop',
      totalCostCents: 17.25,
      usageItems: [],
      tokenCountCheckpoint: 950,
      tokensInCheckpoint: 680,
      tokensOutCheckpoint: 270,
      ownCostCheckpointCents: 17.25,
    })),
  });
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
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: root.agentId } });
    assert.strictEqual(state.prior_status, 'PAUSED');
    assert.strictEqual(state.token_count, 950);
    assert.strictEqual(state.tokens_in, 680);
    assert.strictEqual(state.tokens_out, 270);
    assert.strictEqual(state.tree_tokens_in, 1_360);
    assert.strictEqual(state.tree_tokens_out, 540);
    assert.strictEqual(state.context_size, 42_000);
    assert.strictEqual(state.message_count, 73);
    assert.strictEqual(state.own_cost_cents, 17.25);
    assert.strictEqual(state.subtree_cost_cents, 46.25);
    assert.deepStrictEqual(state.children_cost_cents, { [child.agentId]: 29 });
    assert.deepStrictEqual(state.children_tokens_in, { [child.agentId]: 680 });
    assert.deepStrictEqual(state.children_tokens_out, { [child.agentId]: 270 });
    assert.deepStrictEqual(state.child_last_tokens, {
      [child.agentId]: { tokens_in: 680, tokens_out: 270, token_count: 950 },
    });
    assert.deepStrictEqual(state.child_tool_counts, { web_search: 1 });
    assert.strictEqual(state.iteration_offset, 12);
    assertSameInstant(state.workflow_started_at, stored.createdAt);
    assert.strictEqual(state.max_iterations, 37);
    assert.deepStrictEqual(state.context_gates, { network: false, recent_communications: true });
    return 'pause, exact own/tree counters, tool counts, iteration budget, and config preserved';
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
  await check('late_approval_cannot_overwrite_deployment_terminal', async () => {
    const resolved = await resolveAndSignal(
      {
        id: attentionRequestId,
        workflowId: root.staleWorkflowId,
        agentId: root.agentId,
        metadata: null,
      },
      'APPROVED'
    );
    assert.strictEqual(resolved.resolved, false);
    const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
      where: { id: attentionRequestId },
    });
    assert.strictEqual(request.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    return 'late approval lost the CAS and neither rewrote nor signaled stale work';
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

  await check('sql_trigger_rejects_spawn_after_parent_seal', async () => {
    const fixture = await createDormantAgent('PAUSED');
    await sealValidationParent(fixture);
    const rejectedChildId = randomUUID();
    await assert.rejects(
      () =>
        prisma.agent.create({
          data: {
            id: rejectedChildId,
            userId,
            goal: 'Must not cross a sealed parent generation',
            parentAgentId: fixture.agentId,
            parentWorkflowId: fixture.staleWorkflowId,
            temporalWorkflowId: rejectedChildId,
          },
        }),
      (error: unknown) =>
        (error as { code?: unknown }).code === 'P2034' ||
        (error instanceof Error && /stale parent workflow generation/i.test(error.message))
    );
    assert.strictEqual(await prisma.agent.count({ where: { id: rejectedChildId } }), 0);
    return 'database trigger fenced an old-backend insert before any Temporal start';
  });

  await check('pending_start_tombstone_wins_and_is_terminated', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    await sealValidationParent(fixture);
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: childId } });
    assert.strictEqual(stored.status, 'FAILED');
    assert.strictEqual(stored.temporalWorkflowStartPending, false);
    assert.strictEqual(stored.statusMessage, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    await assertTerminated(childId);
    return 'ambiguous no-start ID was claimed on the dormant tombstone queue and terminated';
  });

  await check('accepted_start_lost_response_is_resolved_and_terminated', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const accepted = await startDormantChild(childId, fixture.agentId, fixture.staleWorkflowId);
    await sealValidationParent(fixture);
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: childId } });
    assert.strictEqual(stored.temporalWorkflowStartPending, false);
    assert.strictEqual(stored.status, 'FAILED');
    assert.strictEqual(accepted.workflowId, childId);
    await assertTerminated(childId);
    return `resolved and terminated exact first chain ${accepted.firstExecutionRunId}`;
  });

  await check('current_parent_is_never_tombstoned', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    let clock = 0;
    let tombstoneClaims = 0;
    await assert.rejects(
      () =>
        drainPendingDescendantWorkflowStarts(
          [fixture.agentId],
          {
            claimExecutionForTermination: async () => {
              tombstoneClaims += 1;
              throw new Error('current parent was tombstoned');
            },
          },
          {
            timeoutMs: 10,
            pollIntervalMs: 5,
            now: () => clock,
            sleep: async (milliseconds) => {
              clock += milliseconds;
            },
          }
        ),
      /did not drain before activation/
    );
    assert.strictEqual(tombstoneClaims, 0);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: childId } }))
        .temporalWorkflowStartPending,
      true
    );
    await sealValidationParent(fixture);
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    return 'activation failed closed until the parent generation was sealed';
  });

  await check('nested_pending_child_and_grandchild_are_quiesced', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const grandchildId = await createPendingChild({
      parentAgentId: childId,
      parentWorkflowId: childId,
      depth: 2,
    });
    await sealValidationParent(fixture);
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    const rows = await prisma.agent.findMany({
      where: { id: { in: [childId, grandchildId] } },
      select: { id: true, status: true, temporalWorkflowStartPending: true },
    });
    assert.strictEqual(rows.length, 2);
    assert(rows.every((row) => row.status === 'FAILED'));
    assert(rows.every((row) => row.temporalWorkflowStartPending === false));
    await Promise.all([assertTerminated(childId), assertTerminated(grandchildId)]);
    return 'recursive drain sealed and terminated both levels';
  });

  await check('termination_failure_retains_pending_for_retry', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const accepted = await startDormantChild(childId, fixture.agentId, fixture.staleWorkflowId);
    await sealValidationParent(fixture);
    await assert.rejects(
      () =>
        reconcileStartedDescendantWorkflow(
          {
            agentId: childId,
            parentAgentId: fixture.agentId,
            parentWorkflowId: fixture.staleWorkflowId,
          },
          accepted,
          {
            terminate: async () => {
              throw new Error('synthetic termination transport failure');
            },
          }
        ),
      /synthetic termination transport failure/
    );
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: childId } }))
        .temporalWorkflowStartPending,
      true
    );
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    await assertTerminated(childId);
    return 'pending exact execution survived the failure and the retry quiesced it';
  });

  await check('post_termination_db_failure_retries_idempotently', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const accepted = await startDormantChild(childId, fixture.agentId, fixture.staleWorkflowId);
    await sealValidationParent(fixture);
    await assert.rejects(
      () =>
        reconcileStartedDescendantWorkflow(
          {
            agentId: childId,
            parentAgentId: fixture.agentId,
            parentWorkflowId: fixture.staleWorkflowId,
          },
          accepted,
          {
            finalizeInterruptedTools: async () => {
              throw new Error('synthetic post-termination DB failure');
            },
          }
        ),
      /synthetic post-termination DB failure/
    );
    await assertTerminated(childId);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: childId } }))
        .temporalWorkflowStartPending,
      true
    );
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: childId } }))
        .temporalWorkflowStartPending,
      false
    );
    return 'typed closed-chain retry completed durable reconciliation';
  });

  await check('active_start_lease_blocks_activation_until_released', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const nowMs = Date.now();
    await prisma.agent.update({
      where: { id: childId },
      data: { temporalWorkflowStartLeaseUntil: new Date(nowMs + 60_000) },
    });
    await sealValidationParent(fixture);
    let clock = nowMs;
    await assert.rejects(
      () =>
        drainPendingDescendantWorkflowStarts(
          [fixture.agentId],
          {},
          {
            timeoutMs: 10,
            pollIntervalMs: 5,
            now: () => clock,
            sleep: async (milliseconds) => {
              clock += milliseconds;
            },
          }
        ),
      /did not drain before activation/
    );
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: childId } }))
        .temporalWorkflowStartPending,
      true
    );
    await prisma.agent.update({
      where: { id: childId },
      data: { temporalWorkflowStartLeaseUntil: null },
    });
    await drainPendingDescendantWorkflowStarts([fixture.agentId]);
    await assertTerminated(childId);
    return 'activation remained closed while the exact start lease was active';
  });

  async function checkAcceptedTerminalChild(
    testName: string,
    status: 'COMPLETED' | 'FAILED'
  ): Promise<void> {
    await check(testName, async () => {
      const fixture = await createDormantAgent('PAUSED');
      const childId = await createPendingChild({
        parentAgentId: fixture.agentId,
        parentWorkflowId: fixture.staleWorkflowId,
      });
      const accepted = await startDormantChild(childId, fixture.agentId, fixture.staleWorkflowId);
      await prisma.agent.update({
        where: { id: childId },
        data: {
          status,
          temporalFirstExecutionRunId: accepted.firstExecutionRunId,
        },
      });
      await reconcileStartedDescendantWorkflow(
        {
          agentId: childId,
          parentAgentId: fixture.agentId,
          parentWorkflowId: fixture.staleWorkflowId,
        },
        accepted
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: childId } });
      assert.strictEqual(stored.status, status);
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
      assert.strictEqual(stored.temporalCleanupPending, false);
      await assertTerminated(childId);
      return `terminal ${status} state won and the accepted exact chain was quiesced`;
    });
  }
  await checkAcceptedTerminalChild('accepted_child_completed_before_postvalidation', 'COMPLETED');
  await checkAcceptedTerminalChild('accepted_child_failed_before_postvalidation', 'FAILED');

  await check('concurrent_duplicate_descendant_finalization_is_idempotent', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const childId = await createPendingChild({
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    });
    const toolCallId = randomUUID();
    await addToolMessage(childId, childId, toolCallId, 'IN_PROGRESS', '');
    const accepted = await startDormantChild(childId, fixture.agentId, fixture.staleWorkflowId);
    await sealValidationParent(fixture);
    const identity = {
      agentId: childId,
      parentAgentId: fixture.agentId,
      parentWorkflowId: fixture.staleWorkflowId,
    };
    await Promise.all([
      reconcileStartedDescendantWorkflow(identity, accepted),
      reconcileStartedDescendantWorkflow(identity, accepted),
    ]);
    await assertTerminated(childId);
    const terminals = await prisma.message.findMany({
      where: { agentId: childId, metadata: { path: ['toolCallId'], equals: toolCallId } },
    });
    assert.strictEqual(
      terminals.filter((row) => row.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE).length,
      1
    );
    return 'both finalizers converged on one terminated chain and one terminal tool result';
  });

  await check('pause_after_fetch_before_atomic_finalize_wins', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    const replacement = await prepare(fixture);
    const fetchedBeforePause = {
      status: 'ACTIVE' as const,
      statusMessage: 'stale fetched state',
      progress: 0.4,
      tokenCount: 950,
      tokensIn: 680,
      tokensOut: 270,
      contextSize: 42_000,
      messageCount: 73,
      iterationOffset: 12,
    };
    await prisma.agent.update({ where: { id: fixture.agentId }, data: { status: 'PAUSED' } });
    const finalized = await finalizeWorkflowReplacementBootstrap(
      fixture.agentId,
      replacement.claim.plannedWorkflowId,
      fetchedBeforePause
    );
    assert.strictEqual(finalized.outcome, 'acknowledged');
    assert.strictEqual(finalized.status, 'PAUSED');
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'PAUSED');
    assert.strictEqual(stored.workflowReplacementToken, null);
    return 'pause committed after fetch was preserved by the generation-lock finalizer';
  });

  await check('resume_during_replacement_claim_wins', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const replacement = await prepare(fixture);
    const intent = await recordWorkflowResumeIntent(fixture.agentId);
    assert.strictEqual(intent.outcome, 'ready');
    if (intent.outcome !== 'ready') throw new Error('resume intent did not reach ready state');
    assert.strictEqual(intent.replacementOwned, true);
    assert.strictEqual(intent.persistedActiveIntent, true);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'ACTIVE');
    const state = stored.workflowReplacementState as Record<string, unknown>;
    assert.strictEqual(state.prior_status, 'ACTIVE');
    const finalized = await finalizeWorkflowReplacementBootstrap(
      fixture.agentId,
      replacement.claim.plannedWorkflowId,
      {
        status: 'PAUSED',
        statusMessage: 'stale paused snapshot',
        progress: 0.4,
        tokenCount: 950,
        tokensIn: 680,
        tokensOut: 270,
        contextSize: 42_000,
        messageCount: 73,
        iterationOffset: 12,
      }
    );
    assert.strictEqual(finalized.status, 'ACTIVE');
    return 'resume intent updated both DB control state and the generation-fenced snapshot';
  });

  await check('credit_restoration_during_replacement_claim_wins', async () => {
    const fixture = await createDormantAgent('OUT_OF_CREDITS');
    const replacement = await prepare(fixture);
    const resumed = await resumeAgentWorkflow(fixture.agentId, {
      hasCredits: async () => true,
      signalResume: async () => {
        throw new Error('replacement-owned credit restore must not signal an unstarted workflow');
      },
    });
    assert.deepStrictEqual(resumed, { success: true });
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'ACTIVE');
    const state = stored.workflowReplacementState as Record<string, unknown>;
    assert.strictEqual(state.prior_status, 'ACTIVE');
    const finalized = await finalizeWorkflowReplacementBootstrap(
      fixture.agentId,
      replacement.claim.plannedWorkflowId,
      {
        status: 'OUT_OF_CREDITS',
        statusMessage: 'stale credit snapshot',
        progress: 0.4,
        tokenCount: 950,
        tokensIn: 680,
        tokensOut: 270,
        contextSize: 42_000,
        messageCount: 73,
        iterationOffset: 12,
      }
    );
    assert.strictEqual(finalized.status, 'ACTIVE');
    return 'verified credits persisted ACTIVE in the claim without signaling stale or unstarted work';
  });

  await check('cost_limit_raise_during_replacement_claim_wins', async () => {
    const fixture = await createDormantAgent('COST_LIMIT_REACHED');
    const replacement = await prepare(fixture);
    assert.strictEqual(
      await updateAgentConfigMutation(
        fixture.agentId,
        { priceLimitCents: 500 },
        undefined,
        replacement.claim.plannedWorkflowId
      ),
      true
    );
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'ACTIVE');
    assert.strictEqual(stored.priceLimitCents, 500);
    const finalized = await finalizeWorkflowReplacementBootstrap(
      fixture.agentId,
      replacement.claim.plannedWorkflowId,
      {
        status: 'COST_LIMIT_REACHED',
        statusMessage: 'stale cost snapshot',
        progress: 0.4,
        tokenCount: 950,
        tokensIn: 680,
        tokensOut: 270,
        contextSize: 42_000,
        messageCount: 73,
        iterationOffset: 12,
      }
    );
    assert.strictEqual(finalized.status, 'ACTIVE');
    return 'new limit and ACTIVE state beat the stale cost-limited bootstrap snapshot';
  });

  await check('legacy_usage_restores_exact_durable_billed_ledger', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    await prisma.toolUsage.createMany({
      data: [1, 2].map(() => ({
        userId,
        agentId: fixture.agentId,
        toolName: 'execute_loop',
        totalCostCents: 999,
        usageItems: [
          {
            type: 'llm',
            number_of_tokens: 99_999,
            tokens_in: 88_888,
            tokens_out: 11_111,
          },
        ],
      })),
    });
    const replacement = await prepare(fixture);
    assert.strictEqual(replacement.claim.resumeState.token_count, 199_998);
    assert.strictEqual(replacement.claim.resumeState.tokens_in, 177_776);
    assert.strictEqual(replacement.claim.resumeState.tokens_out, 22_222);
    assert.strictEqual(replacement.claim.resumeState.own_cost_cents, 17.25);
    return 'legacy retry rows were restored exactly as the durable billing ledger records them';
  });

  await check('concurrent_keyed_accounting_checkpoint_is_exact_once', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    const operationKey = `prod-validation:${runId}:${fixture.agentId}:accounting`;
    const input = {
      agent_id: fixture.agentId,
      user_id: userId,
      tool_name: 'execute_loop',
      total_cost_cents: 20,
      usage_items: [{ type: 'llm', number_of_tokens: 950, tokens_in: 800, tokens_out: 150 }],
      operation_key: operationKey,
      accounting_checkpoint: {
        token_count: 1_900,
        tokens_in: 1_500,
        tokens_out: 400,
        own_cost_cents: 33.25,
      },
      workflow_generation: fixture.staleWorkflowId,
    };
    const writes = await Promise.all([saveToolUsage(input), saveToolUsage(input)]);
    assert.strictEqual(writes[0].id, writes[1].id);
    assert.strictEqual(await prisma.toolUsage.count({ where: { operationKey } }), 1);
    const replacement = await prepare(fixture);
    assert.strictEqual(replacement.claim.resumeState.token_count, 1_900);
    assert.strictEqual(replacement.claim.resumeState.tokens_in, 1_500);
    assert.strictEqual(replacement.claim.resumeState.tokens_out, 400);
    assert.strictEqual(replacement.claim.resumeState.own_cost_cents, 33.25);
    return 'concurrent retry produced one row and restored the cumulative checkpoint exactly';
  });

  await check('provider_attempt_retries_do_not_inflate_iteration_offset', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    const operationKey = `prod-validation:${runId}:${fixture.agentId}:iteration`;
    const input = {
      agent_id: fixture.agentId,
      user_id: userId,
      tool_name: 'execute_loop',
      total_cost_cents: 0,
      usage_items: [{ type: 'llm', iteration: 20, tokens_in: 1, tokens_out: 1 }],
      operation_key: operationKey,
      workflow_generation: fixture.staleWorkflowId,
    };
    await Promise.all([saveToolUsage(input), saveToolUsage(input)]);
    assert.strictEqual(await prisma.toolUsage.count({ where: { operationKey } }), 1);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }))
        .workflowIterationOffset,
      20
    );
    const replacement = await prepare(fixture);
    assert.strictEqual(replacement.claim.resumeState.iteration_offset, 20);
    return 'two activity attempts produced one ledger row and one logical iteration checkpoint';
  });

  await check('terminal_db_live_temporal_root_is_cleaned_exactly_once', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    const toolCallId = randomUUID();
    await addToolMessage(fixture.agentId, fixture.staleWorkflowId, toolCallId, 'IN_PROGRESS', '');
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: 'COMPLETED' },
    });
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }))
        .temporalCleanupPending,
      true
    );
    const cleaned = await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    assert.strictEqual(cleaned.terminated, 1);
    await assertTerminated(fixture.staleWorkflowId);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'COMPLETED');
    assert.strictEqual(stored.temporalCleanupPending, false);
    const toolRows = await prisma.message.findMany({
      where: { agentId: fixture.agentId, metadata: { path: ['toolCallId'], equals: toolCallId } },
    });
    assert.strictEqual(
      toolRows.filter((row) => row.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE).length,
      1
    );
    const rerun = await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    assert.strictEqual(rerun.discovered, 0);
    return 'terminal status preserved, exact chain stopped, tool closed once, rerun was a no-op';
  });

  await check('soft_deleted_live_temporal_workflow_is_not_invisible', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { deletedAt: new Date() },
    });
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }))
        .temporalCleanupPending,
      true
    );
    await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    await assertTerminated(fixture.staleWorkflowId);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert(stored.deletedAt instanceof Date);
    assert.strictEqual(stored.status, 'ACTIVE');
    assert.strictEqual(stored.temporalCleanupPending, false);
    return 'soft deletion retained the exact cleanup obligation through termination';
  });

  await check('terminal_db_live_temporal_descendant_is_cleaned_exactly_once', async () => {
    const parent = await createDormantAgent('PAUSED');
    const fixture = await createDormantAgent('ACTIVE', { parentAgentId: parent.agentId });
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: 'FAILED' },
    });
    const first = await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    assert.strictEqual(first.terminated, 1);
    await assertTerminated(fixture.staleWorkflowId);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.status, 'FAILED');
    assert.strictEqual(stored.temporalCleanupPending, false);
    const second = await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    assert.strictEqual(second.discovered, 0);
    return 'terminal descendant exact chain stopped once without mutating terminal state';
  });

  await check('rapid_terminal_generations_each_keep_exact_cleanup_obligation', async () => {
    const fixture = await createDormantAgent('ACTIVE');
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: 'COMPLETED' },
    });
    const secondWorkflowId = `${fixture.agentId}:prod-validation:second`;
    const second = await startAgentWorkflowExecution({
      agentId: fixture.agentId,
      userId,
      goal: 'Second production cleanup generation',
      model: 'rose-labs/rose-1-flash',
      reasoningMaxTokens: 256,
      verifier: { type: 'FLOAT_LLM_JUDGE' },
      taskQueue: dormantQueue,
      workflowId: secondWorkflowId,
      startPhase: 'execute',
      maxIterations: 10,
      priceLimitCents: 100,
    });
    workflowIds.add(secondWorkflowId);
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: {
        status: 'ACTIVE',
        temporalWorkflowId: secondWorkflowId,
        temporalFirstExecutionRunId: second.firstExecutionRunId,
      },
    });
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: 'FAILED' },
    });
    assert.strictEqual(
      await prisma.temporalWorkflowCleanup.count({ where: { agentId: fixture.agentId } }),
      2
    );
    await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    await cleanupTerminalAgentWorkflowZombies(
      {},
      { agentIds: [fixture.agentId], ignoreGrace: true }
    );
    await Promise.all([
      assertTerminated(fixture.staleWorkflowId),
      assertTerminated(secondWorkflowId),
    ]);
    assert.strictEqual(
      await prisma.temporalWorkflowCleanup.count({ where: { agentId: fixture.agentId } }),
      0
    );
    return 'both exact generations survived rapid reactivation and were independently terminated';
  });

  let pausedHandle: Awaited<ReturnType<typeof startAndReady>> | undefined;
  await check('candidate_bootstrap_durable_ready', async () => {
    assert(preparedRoot);
    pausedHandle = await startAndReady(preparedRoot);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: root.agentId } });
    assert.strictEqual(stored.workflowReplacementToken, null);
    assert.strictEqual(stored.status, 'PAUSED');
    assert.strictEqual(stored.temporalWorkflowId, pausedHandle.workflowId);
    assert.strictEqual(stored.tokenCount, 950);
    assert.strictEqual(stored.tokensIn, 680);
    assert.strictEqual(stored.tokensOut, 270);
    assert.strictEqual(stored.contextSize, 42_000);
    assert.strictEqual(stored.messageCount, 73);
    assert.strictEqual(stored.workflowIterationOffset, 12);
    assert.strictEqual(stored.priceLimitCents, 250);
    assert.deepStrictEqual(stored.toolsInUse, []);
    assert.deepStrictEqual(stored.responseSchema, {
      fields: [{ name: 'answer', type: 'string' }],
    });
    assert.strictEqual(await pausedHandle.handle.query('is_paused_query'), true);
    const runtime = (await pausedHandle.handle.query('get_status')) as Record<string, unknown>;
    assert.strictEqual(runtime.tokens, 950);
    assert.strictEqual(runtime.tokens_in, 680);
    assert.strictEqual(runtime.tokens_out, 270);
    assert.strictEqual(runtime.context_size, 42_000);
    assert.strictEqual(runtime.message_count, 73);
    assert.strictEqual(runtime.iteration_offset, 12);
    assertSameInstant(runtime.workflow_started_at, stored.createdAt);
    return 'restored counters, duration origin, controls, and stale running-tool UI';
  });
  await check('cold_workflow_uses_no_resources_while_waiting', async () => {
    assert(pausedHandle);
    const after = await assertColdHandoffHistoryStable(pausedHandle.handle);
    return `${after.totalEvents} total history events; handoff timer armed; zero growth inside poll window`;
  });
  await check('fresh_history_has_no_patch_or_nondeterminism', async () => {
    assert(pausedHandle);
    const counts = await activityCount(pausedHandle.handle);
    assert.strictEqual(counts.markers, 0);
    assert.strictEqual(counts.workflowTaskFailures, 0);
  });

  await check('failed_candidate_next_deploy_rotates_generation', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const preparedA = await prepareAgentWorkflowReplacement(fixture.agentId, undefined, {
      expectedWorkflowId: fixture.staleWorkflowId,
      deploymentAttempt: `validation-build-a:${runId}`,
      deadlineAtMs: Date.now() + 120_000,
    });
    assert.strictEqual(preparedA.prepared, true);
    if (preparedA.prepared !== true) throw new Error('candidate A was not prepared');

    const candidateA = await startAgentWorkflowExecution({
      agentId: fixture.agentId,
      userId,
      goal: 'Production workflow replacement retry validation fixture',
      model: 'rose-labs/rose-1-flash',
      reasoningMaxTokens: 256,
      verifier: { type: 'FLOAT_LLM_JUDGE' },
      taskQueue: dormantQueue,
      workflowId: preparedA.claim.plannedWorkflowId,
      startPhase: 'resume',
      priceLimitCents: 250,
      ...(preparedA.claim.resumeState.max_iterations === null
        ? {}
        : { maxIterations: preparedA.claim.resumeState.max_iterations }),
      ...(preparedA.claim.resumeState.context_gates === null
        ? {}
        : { contextGates: preparedA.claim.resumeState.context_gates }),
      resumeState: preparedA.claim.resumeState,
    });
    workflowIds.add(candidateA.workflowId);
    await recordWorkflowReplacementStartAcceptance(preparedA.claim, candidateA);
    await prisma.agent.update({
      where: { id: fixture.agentId },
      data: { status: 'FAILED', statusMessage: 'candidate A failed before READY' },
    });

    const preparedB = await prepareAgentWorkflowReplacement(fixture.agentId, undefined, {
      expectedWorkflowId: candidateA.workflowId,
      deploymentAttempt: `validation-build-b:${runId}`,
      deadlineAtMs: Date.now() + 120_000,
    });
    assert.strictEqual(preparedB.prepared, true);
    if (preparedB.prepared !== true) throw new Error('candidate B was not prepared');
    assert.notStrictEqual(preparedB.claim.plannedWorkflowId, candidateA.workflowId);
    assert.strictEqual(preparedB.claim.staleWorkflowId, candidateA.workflowId);
    assert.strictEqual(preparedB.claim.resumeState.prior_status, 'PAUSED');
    assert.strictEqual(preparedB.claim.resumeState.token_count, 950);
    assert.strictEqual(
      preparedB.claim.resumeState.deployment_attempt,
      `validation-build-b:${runId}`
    );
    await assertTerminated(candidateA.workflowId);

    const ready = await startAndReady(preparedB);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.temporalWorkflowId, ready.workflowId);
    assert.strictEqual(stored.workflowReplacementToken, null);
    assert.strictEqual(stored.status, 'PAUSED');
    assert.strictEqual(await ready.handle.query('is_paused_query'), true);
    return 'candidate A terminated; candidate B minted clean and restored the original durable snapshot';
  });

  await check('late_stale_replacement_start_is_compensated', async () => {
    const fixture = await createDormantAgent('PAUSED');
    const preparedA = await prepareAgentWorkflowReplacement(fixture.agentId, undefined, {
      expectedWorkflowId: fixture.staleWorkflowId,
      deploymentAttempt: `late-start-build-a:${runId}`,
      deadlineAtMs: Date.now() + 120_000,
    });
    assert.strictEqual(preparedA.prepared, true);
    if (preparedA.prepared !== true) throw new Error('late-start candidate A was not prepared');
    const preparedB = await prepareAgentWorkflowReplacement(fixture.agentId, undefined, {
      expectedWorkflowId: preparedA.claim.plannedWorkflowId,
      deploymentAttempt: `late-start-build-b:${runId}`,
      deadlineAtMs: Date.now() + 120_000,
    });
    assert.strictEqual(preparedB.prepared, true);
    if (preparedB.prepared !== true) throw new Error('late-start candidate B was not prepared');

    const lateA = await startAgentWorkflowExecution({
      agentId: fixture.agentId,
      userId,
      goal: 'Late stale workflow replacement start validation fixture',
      model: 'rose-labs/rose-1-flash',
      reasoningMaxTokens: 256,
      verifier: { type: 'FLOAT_LLM_JUDGE' },
      taskQueue: dormantQueue,
      workflowId: preparedA.claim.plannedWorkflowId,
      startPhase: 'resume',
      priceLimitCents: 250,
      ...(preparedA.claim.resumeState.max_iterations === null
        ? {}
        : { maxIterations: preparedA.claim.resumeState.max_iterations }),
      ...(preparedA.claim.resumeState.context_gates === null
        ? {}
        : { contextGates: preparedA.claim.resumeState.context_gates }),
      resumeState: preparedA.claim.resumeState,
    });
    workflowIds.add(lateA.workflowId);
    await assert.rejects(
      acceptStartedWorkflowReplacement(preparedA.claim, lateA, Date.now() + 120_000),
      /became stale before start acceptance and was terminated/
    );
    await assertTerminated(lateA.workflowId);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert.strictEqual(stored.temporalWorkflowId, preparedB.claim.plannedWorkflowId);
    assert.strictEqual(stored.workflowReplacementToken, preparedB.claim.token);
    assert.strictEqual(
      await prisma.temporalWorkflowCleanup.count({
        where: { agentId: fixture.agentId, workflowId: lateA.workflowId },
      }),
      0
    );
    return 'late candidate A start was rejected, terminated, reconciled, and could not displace candidate B';
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
      await assertColdHandoffHistoryStable(ready.handle, { observeMs: 1_000 });
      return `${status} restored cold; handoff timer armed; zero growth inside poll window`;
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

  await check('malformed_root_preflight_leaves_healthy_peer_untouched', async () => {
    const healthy = await createDormantAgent('PAUSED');
    const malformed = await createDormantAgent('PAUSED', { verifier: false });
    const healthyBefore = await prisma.agent.findUniqueOrThrow({ where: { id: healthy.agentId } });
    const messageCountBefore = await prisma.message.count({ where: { agentId: healthy.agentId } });
    let prepareCalls = 0;
    const cutover = await runWorkflowDeploymentCutover(
      [
        {
          agentId: healthy.agentId,
          workflowId: healthy.staleWorkflowId,
          status: 'PAUSED',
        },
        {
          agentId: malformed.agentId,
          workflowId: malformed.staleWorkflowId,
          status: 'PAUSED',
        },
      ],
      {
        preflight: async (candidate) => {
          const result = await preflightAgentWorkflowReplacement(candidate.agentId, undefined, {
            expectedWorkflowId: candidate.workflowId,
          });
          if (result.outcome === 'failed') throw new Error(result.error);
          return result;
        },
        prepare: async () => {
          prepareCalls += 1;
          throw new Error('prepare must not run after a fleet preflight failure');
        },
        activate: async () => {
          throw new Error('activation must not run after a fleet preflight failure');
        },
        start: async () => {
          throw new Error('start must not run after a fleet preflight failure');
        },
        waitUntilReady: async () => undefined,
      },
      { concurrency: 2, canaryCount: 1 }
    );
    assert.strictEqual(cutover.haltedAfter, 'preflight');
    assert.strictEqual(prepareCalls, 0);
    const healthyAfter = await prisma.agent.findUniqueOrThrow({ where: { id: healthy.agentId } });
    assert.deepStrictEqual(healthyAfter, healthyBefore);
    assert.strictEqual(
      await prisma.message.count({ where: { agentId: healthy.agentId } }),
      messageCountBefore
    );
    const healthyExecution = await (
      await getTemporalClient()
    ).workflow
      .getHandle(healthy.staleWorkflowId, undefined, {
        firstExecutionRunId: healthy.staleExecution.firstExecutionRunId,
      })
      .describe();
    assert.strictEqual(healthyExecution.status.name, 'RUNNING');
    return 'healthy peer retained exact DB state, messages, and RUNNING Temporal chain';
  });

  await check('http_single_lost_201_retry_reuses_exact_child', async () => {
    const parent = await createDormantAgent('PAUSED');
    const request = childRequest(parent);
    const first = await postProductionAgent('/api/agents', request);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstStored = await prisma.agent.findUniqueOrThrow({
      where: { id: request.agent_id },
    });
    assert.strictEqual(firstStored.temporalWorkflowStartPending, false);
    assert.notStrictEqual(firstStored.temporalFirstExecutionRunId, null);

    const retry = await postProductionAgent('/api/agents', request);
    assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
    assert.strictEqual(retry.body.agent_id, request.agent_id);
    assert.strictEqual(retry.body.temporal_workflow_id, request.agent_id);
    const retryStored = await prisma.agent.findUniqueOrThrow({
      where: { id: request.agent_id },
    });
    assert.strictEqual(
      retryStored.temporalFirstExecutionRunId,
      firstStored.temporalFirstExecutionRunId
    );
    assert.strictEqual(await prisma.agent.count({ where: { id: request.agent_id } }), 1);
    return 'discarded 201 retry returned one DB row and the same exact Temporal chain';
  });

  await check('http_batch_changed_payload_is_rejected', async () => {
    const parent = await createDormantAgent('PAUSED');
    const request = childRequest(parent);
    const first = await postProductionAgent('/api/agents/batch', { agents: [request] });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const collision = await postProductionAgent('/api/agents/batch', {
      agents: [{ ...request, goal: `${request.goal} changed` }],
    });
    assert.strictEqual(collision.status, 409, JSON.stringify(collision.body));
    assert.match(String(collision.body.error), /changed immutable field goal/);
    assert.strictEqual(
      (await prisma.agent.findUniqueOrThrow({ where: { id: request.agent_id } })).goal,
      request.goal
    );
    return 'stable child ID rejected drift instead of binding new inputs to old history';
  });

  await check('http_batch_mixed_retry_reconciles_each_child_once', async () => {
    const parent = await createDormantAgent('PAUSED');
    const pending = childRequest(parent);
    const settled = childRequest(parent);
    const first = await postProductionAgent('/api/agents/batch', {
      agents: [pending, settled],
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const acceptedRunId = (
      await prisma.agent.findUniqueOrThrow({ where: { id: pending.agent_id } })
    ).temporalFirstExecutionRunId;
    assert.notStrictEqual(acceptedRunId, null);
    await prisma.agent.update({
      where: { id: pending.agent_id },
      data: {
        status: 'STARTING_UP',
        temporalWorkflowId: pending.agent_id,
        temporalFirstExecutionRunId: null,
        temporalWorkflowStartPending: true,
        temporalWorkflowStartLeaseUntil: null,
      },
    });
    const fresh = childRequest(parent);
    const retry = await postProductionAgent('/api/agents/batch', {
      agents: [pending, settled, fresh],
    });
    assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
    const responseRows = retry.body.results;
    assert(Array.isArray(responseRows));
    const byId = new Map(
      responseRows.map((row) => {
        assert(typeof row === 'object' && row !== null);
        const value = row as Record<string, unknown>;
        return [value.agent_id, value];
      })
    );
    assert.strictEqual(byId.get(settled.agent_id)?.already_existed, true);
    assert.strictEqual(byId.get(pending.agent_id)?.temporal_workflow_id, pending.agent_id);
    assert.strictEqual(byId.get(fresh.agent_id)?.temporal_workflow_id, fresh.agent_id);
    const pendingStored = await prisma.agent.findUniqueOrThrow({
      where: { id: pending.agent_id },
    });
    assert.strictEqual(pendingStored.temporalWorkflowStartPending, false);
    assert.strictEqual(pendingStored.temporalFirstExecutionRunId, acceptedRunId);
    assert.strictEqual(
      await prisma.agent.count({
        where: { id: { in: [pending.agent_id, settled.agent_id, fresh.agent_id] } },
      }),
      3
    );
    return 'pending, settled, and fresh children converged without duplicate rows or histories';
  });

  await check('known_massive_zombie_generations_are_not_running', async () => {
    const prefixes = ['89eb7d14', '2d546011', 'da7a7da9'];
    const client = await getTemporalClient();
    const runningMatches: string[] = [];
    for await (const execution of client.workflow.list({
      query: 'ExecutionStatus = "Running"',
    })) {
      if (prefixes.some((prefix) => execution.workflowId.startsWith(prefix))) {
        runningMatches.push(execution.workflowId);
      }
    }
    const ownerRows = await prisma.agent.findMany({
      where: {
        OR: prefixes.flatMap((prefix) => [
          { temporalWorkflowId: { startsWith: prefix } },
          { staleTemporalWorkflowId: { startsWith: prefix } },
        ]),
      },
      select: { id: true, userId: true, goal: true, status: true, temporalWorkflowId: true },
    });
    assert.deepStrictEqual(
      runningMatches,
      [],
      `known zombie workflow(s) remain: ${JSON.stringify({ runningMatches, ownerRows })}`
    );
    return `zero RUNNING executions for ${prefixes.join(', ')}; owners=${JSON.stringify(ownerRows)}`;
  });

  await check('production_fleet_has_no_stuck_cutover_state', async () => {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - 10 * 60_000);
    const [overdueCleanupObligations, stalePendingStarts, staleReplacementClaims] =
      await Promise.all([
        prisma.temporalWorkflowCleanup.count({
          where: {
            agent: { userId: { not: userId } },
            notBefore: { lte: staleCutoff },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
        }),
        prisma.agent.count({
          where: {
            userId: { not: userId },
            temporalWorkflowStartPending: true,
            createdAt: { lte: staleCutoff },
            OR: [
              { temporalWorkflowStartLeaseUntil: null },
              { temporalWorkflowStartLeaseUntil: { lt: now } },
            ],
          },
        }),
        prisma.agent.count({
          where: {
            userId: { not: userId },
            workflowReplacementToken: { not: null },
            updatedAt: { lte: staleCutoff },
          },
        }),
      ]);
    assert.deepStrictEqual(
      { overdueCleanupObligations, stalePendingStarts, staleReplacementClaims },
      { overdueCleanupObligations: 0, stalePendingStarts: 0, staleReplacementClaims: 0 }
    );
    return 'zero due-and-unleased cleanup obligations or cutover states stalled for 10+ minutes';
  });

  await check('same_sha_old_marker_is_retired_without_retiring_current_attempt', async () => {
    const buildId = process.env.TEMPORAL_WORKER_BUILD_ID!;
    // Mint both markers under unique validation tokens. Cooperative cutover does
    // not keep deploy activation markers running, and a prior validation pass may
    // leave the real deploy-token marker TERMINATED (activate then throws).
    const currentToken = `validation-current-${runId}`;
    const oldToken = `validation-old-${runId}`;
    const currentMarkerId = await activateTemporalWorkerBuild(buildId, currentToken);
    workflowIds.add(currentMarkerId);
    const oldMarkerId = await activateTemporalWorkerBuild(buildId, oldToken);
    workflowIds.add(oldMarkerId);
    assert.notStrictEqual(oldMarkerId, currentMarkerId);

    const client = await getTemporalClient();
    const visibilityDeadline = Date.now() + 30_000;
    let visible = false;
    do {
      for await (const execution of client.workflow.list({
        query: 'WorkflowType="RoseWorkerDeploymentActivationMarker" AND ExecutionStatus="Running"',
      })) {
        if (execution.workflowId === oldMarkerId) visible = true;
      }
      if (!visible) await new Promise((resolve) => setTimeout(resolve, 500));
    } while (!visible && Date.now() < visibilityDeadline);
    assert(visible, 'validation activation marker was not visible in the cleanup query');

    // cleanupSupersededWorkerActivationMarkers enumerates markers via Temporal
    // visibility (Elasticsearch), which is eventually consistent: a just-created
    // marker that this test already confirmed "Running" can still be absent from
    // a single subsequent visibility snapshot, so one cleanup pass may not see it
    // to terminate it. Production activation runs cleanup on every deploy, so a
    // straggler is retired on the next pass — the property under test is that a
    // superseded same-SHA marker IS retired, within the visibility-consistency
    // window, not that a single snapshot catches it. Retry the idempotent cleanup
    // (bounded) until visibility catches up. The assertion is unchanged: the old
    // marker must end TERMINATED and the exact current marker must stay RUNNING.
    const retirementDeadline = Date.now() + 60_000;
    let oldMarkerStatus = 'RUNNING';
    do {
      await cleanupSupersededWorkerActivationMarkers(currentMarkerId);
      oldMarkerStatus = (await client.workflow.getHandle(oldMarkerId).describe()).status.name;
      if (oldMarkerStatus === 'TERMINATED') break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < retirementDeadline);
    assert.strictEqual(
      oldMarkerStatus,
      'TERMINATED',
      'superseded same-SHA marker was not retired within the visibility-consistency window'
    );
    const current = await client.workflow.getHandle(currentMarkerId).describe();
    assert.strictEqual(current.status.name, 'RUNNING');
    return 'same-SHA old attempt marker retired while exact current deployment stayed active';
  });
}

async function cleanup(): Promise<void> {
  const client = await getTemporalClient();
  for (const workflowId of workflowIds) {
    try {
      await client.workflow
        .getHandle(workflowId)
        .terminate('Production migration validation cleanup');
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
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

// A terminated run (tool or CI timeout, Ctrl-C) skips the `.finally` below and
// would strand this run's synthetic agents and workflows in production. Remove
// them by the run-unique user and queue, then exit with the signal's status.
async function cleanupInterruptedRun(): Promise<void> {
  const client = await getTemporalClient();
  for await (const execution of client.workflow.list({
    query: `TaskQueue = "${dormantQueue}" AND ExecutionStatus = "Running"`,
  })) {
    workflowIds.add(execution.workflowId);
  }
  const rows = await prisma.agent.findMany({
    where: { userId },
    select: { id: true, temporalWorkflowId: true },
  });
  for (const row of rows) {
    agentIds.add(row.id);
    if (row.temporalWorkflowId !== null) workflowIds.add(row.temporalWorkflowId);
  }
  await cleanup();
}

let interruptedBySignal = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (interruptedBySignal) return;
    interruptedBySignal = true;
    void withTimeout('interrupted_fixture_cleanup', cleanupInterruptedRun(), 120_000)
      .catch((error: unknown) => {
        process.stderr.write(
          `fixture cleanup after ${signal} failed (user ${userId}): ${
            error instanceof Error ? error.message : String(error)
          }\n`
        );
      })
      .finally(() => {
        const release = deploymentLease === null ? Promise.resolve() : deploymentLease.release();
        void release
          .catch(() => undefined)
          .then(() => prisma.$disconnect())
          .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
      });
  });
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
      await withTimeout('fixture_cleanup', cleanup(), 120_000);
      const [remainingAgents, remainingRequests] = await Promise.all([
        prisma.agent.count({ where: { id: { in: [...agentIds] } } }),
        prisma.agentAttentionRequest.count({ where: { userId } }),
      ]);
      assert.strictEqual(remainingAgents, 0);
      assert.strictEqual(remainingRequests, 0);
      results.push({
        test: 'fixture_cleanup',
        status: 'PASS',
        detail: 'all synthetic DB rows and Temporal execution IDs were removed or closed',
      });
    } catch (error) {
      results.push({
        test: 'fixture_cleanup',
        status: 'FAIL',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
    if (deploymentLease !== null) {
      try {
        await deploymentLease.release();
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
