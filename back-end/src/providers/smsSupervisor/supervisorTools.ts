/**
 * SMS Supervisor Tools
 *
 * 6 tools available to the SMS supervisor LLM:
 * 1. reply_to_agent — Send a reply to an agent (answers questions, approves/rejects write-locks)
 * 2. kill_agent — Terminate an agent and all sub-agents
 * 3. increase_budget — Increase an agent's cost limit
 * 4. start_new_agent — Create and start a new agent
 * 5. web_search — Search the web for information
 * 6. attempt_completion — Send final SMS to user (loop terminator)
 *
 * Each tool has a JSON schema for the LLM and an executor function.
 * All executors log extensively at boundaries.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../database';
import { startAgentWorkflow, getTemporalClient } from '../temporal';
import { executeWebSearch } from '../chat/chatTools';
import { getAgentUrl } from '../smsTemplates';
import { createMessage } from '../messages';
import { createLogger } from '../logger';
import { deleteAgentRecursive, resolveAgentPrefix } from './supervisorTools.helpers';

const log = createLogger('SmsSupervisorTools');

export { TOOL_SCHEMAS } from './supervisorTools.schemas';

// ============================================
// Tool Call Type
// ============================================

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

// Per-tool argument types (validated upstream via JSON schema)
interface ReplyToAgentArgs {
  agent_id_or_prefix: string;
  message: string;
  attention_request_id?: string;
  reject?: boolean;
}

interface KillAgentArgs {
  agent_id_or_prefix: string;
}

interface IncreaseBudgetArgs {
  agent_id_or_prefix: string;
  amount_dollars: number;
}

interface StartNewAgentArgs {
  goal: string;
  budget_dollars?: number;
}

interface WebSearchArgs {
  query: string;
}

// ============================================
// Prefix Resolution Helper
// ============================================

// resolveAgentPrefix + deleteAgentRecursive live in supervisorTools.helpers.ts
// so this file stays under the max-lines budget. Both are pure DB/Temporal
// operations with no tool-specific logic.

// ============================================
// Deferred-commit pipeline (WS-2)
// ============================================
//
// Read-only tools run inline so the model sees their results within the same
// LLM round-trip. Write tools (start_new_agent, kill_agent, increase_budget,
// reply_to_agent) are NEVER executed inside the loop — they only get queued
// to a per-run `PendingOp[]` buffer. The supervisor handler later calls
// `commitPendingWrites` exactly once, at attempt_completion, after re-checking
// that no newer inbound SMS arrived. If the gate denies the commit, the buffer
// is discarded; no side effect ever fires.
//
// This gives us:
//   - Natural debounce: a follow-up SMS while a run is mid-flight invalidates
//     the queued writes; only the latest run produces side effects + reply.
//   - Atomic per-turn commit: every queued op fires together with the SMS, or
//     none of them do.
//   - Idempotency without per-tool rollback: writes never run speculatively,
//     so there's nothing to undo on abort.

export type PendingOp =
  | { kind: 'reply_to_agent'; args: ReplyToAgentArgs; agentId: string }
  | { kind: 'kill_agent'; args: KillAgentArgs; agentId: string }
  | { kind: 'increase_budget'; args: IncreaseBudgetArgs; agentId: string }
  | { kind: 'start_new_agent'; args: StartNewAgentArgs; provisionalId: string };

/**
 * Tool dispatcher used inside the supervisor loop. Read tools execute inline;
 * write tools validate args, push a {@link PendingOp} onto `pendingWrites`,
 * and return a synthetic "queued" tool_result so the model can keep reasoning.
 */
export async function dispatchToolCall(
  toolCall: ToolCall,
  userId: string,
  pendingWrites: PendingOp[]
): Promise<ToolResult> {
  const startTime = Date.now();
  const { tool, arguments: args } = toolCall;

  log.info('Dispatching tool', { tool, args: JSON.stringify(args), userId });

  try {
    let result: ToolResult;

    switch (tool) {
      case 'reply_to_agent':
        result = await validateReplyToAgent(
          args as unknown as ReplyToAgentArgs,
          userId,
          pendingWrites
        );
        break;
      case 'kill_agent':
        result = await validateKillAgent(args as unknown as KillAgentArgs, userId, pendingWrites);
        break;
      case 'increase_budget':
        result = await validateIncreaseBudget(
          args as unknown as IncreaseBudgetArgs,
          userId,
          pendingWrites
        );
        break;
      case 'start_new_agent':
        result = validateStartNewAgent(args as unknown as StartNewAgentArgs, pendingWrites);
        break;
      case 'web_search':
        result = await executeWebSearchTool(args as unknown as WebSearchArgs);
        break;
      case 'attempt_completion':
        // Loop terminator — the handler intercepts before reaching this point.
        result = { tool, success: true, result: 'Completion signaled' };
        break;
      default:
        result = { tool, success: false, result: '', error: `Unknown tool: ${tool}` };
    }

    log.info('Tool dispatch complete', {
      tool,
      success: result.success,
      resultLength: result.result.length,
      error: result.error,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Tool dispatch failed', {
      tool,
      args: JSON.stringify(args),
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - startTime,
    });
    return { tool, success: false, result: '', error: errorMsg };
  }
}

/**
 * Flush every queued {@link PendingOp} in order. Called by the supervisor
 * handler under the per-user commit lock, after the inbound-seq gate has
 * confirmed this run is still the most-recent. Returns one {@link ToolResult}
 * per op describing what actually happened (for logging / transcript shape).
 *
 * Each commit function is idempotent enough for v1:
 *   - start_new_agent: client-supplied provisional UUID; a duplicate `create`
 *     collides on PK and is caught.
 *   - kill_agent: deleting an already-deleted agent is a no-op.
 *   - increase_budget / reply_to_agent: the per-user commit lock + seq gate
 *     ensures we never reach commit twice for the same run.
 */
export async function commitPendingWrites(
  pendingWrites: readonly PendingOp[],
  userId: string
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const op of pendingWrites) {
    const start = Date.now();
    try {
      let result: ToolResult;
      switch (op.kind) {
        case 'reply_to_agent':
          result = await commitReplyToAgent(op, userId);
          break;
        case 'kill_agent':
          result = await commitKillAgent(op);
          break;
        case 'increase_budget':
          result = await commitIncreaseBudget(op);
          break;
        case 'start_new_agent':
          result = await commitStartNewAgent(op, userId);
          break;
      }
      log.info('Pending op committed', {
        kind: op.kind,
        success: result.success,
        durationMs: Date.now() - start,
      });
      results.push(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Pending op commit failed', {
        kind: op.kind,
        error: errorMsg,
        durationMs: Date.now() - start,
      });
      results.push({ tool: op.kind, success: false, result: '', error: errorMsg });
    }
  }
  return results;
}

// ============================================
// Validators — fast, side-effect-free; queue PendingOps
// ============================================

async function validateReplyToAgent(
  args: ReplyToAgentArgs,
  userId: string,
  pendingWrites: PendingOp[]
): Promise<ToolResult> {
  const agent = await resolveAgentPrefix(args.agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: `No agent found matching "${args.agent_id_or_prefix}"`,
    };
  }
  pendingWrites.push({ kind: 'reply_to_agent', args, agentId: agent.id });
  const verb = args.attention_request_id
    ? args.reject
      ? 'will reject'
      : 'will approve'
    : 'will reply';
  return {
    tool: 'reply_to_agent',
    success: true,
    result: `queued: ${verb} → agent [${agent.id.substring(0, 6)}]`,
  };
}

async function validateKillAgent(
  args: KillAgentArgs,
  userId: string,
  pendingWrites: PendingOp[]
): Promise<ToolResult> {
  const agent = await resolveAgentPrefix(args.agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'kill_agent',
      success: false,
      result: '',
      error: `No agent found matching "${args.agent_id_or_prefix}"`,
    };
  }
  pendingWrites.push({ kind: 'kill_agent', args, agentId: agent.id });
  return {
    tool: 'kill_agent',
    success: true,
    result: `queued: will kill agent [${agent.id.substring(0, 6)}]`,
  };
}

async function validateIncreaseBudget(
  args: IncreaseBudgetArgs,
  userId: string,
  pendingWrites: PendingOp[]
): Promise<ToolResult> {
  const agent = await resolveAgentPrefix(args.agent_id_or_prefix, userId);
  if (!agent) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `No agent found matching "${args.agent_id_or_prefix}"`,
    };
  }
  if (!Number.isFinite(args.amount_dollars) || args.amount_dollars <= 0) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `amount_dollars must be a positive number, got ${args.amount_dollars}`,
    };
  }
  pendingWrites.push({ kind: 'increase_budget', args, agentId: agent.id });
  return {
    tool: 'increase_budget',
    success: true,
    result: `queued: will add $${args.amount_dollars.toFixed(2)} to agent [${agent.id.substring(0, 6)}]`,
  };
}

function validateStartNewAgent(args: StartNewAgentArgs, pendingWrites: PendingOp[]): ToolResult {
  if (!args.goal || typeof args.goal !== 'string' || args.goal.trim().length === 0) {
    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: 'goal is required and must be a non-empty string',
    };
  }
  const provisionalId = randomUUID();
  pendingWrites.push({ kind: 'start_new_agent', args, provisionalId });
  return {
    tool: 'start_new_agent',
    success: true,
    result: `queued: will start agent [${provisionalId.substring(0, 6)}] for "${args.goal.substring(0, 80)}"`,
  };
}

// ============================================
// Commit Implementations — run inside the commit gate, exactly once per run
// ============================================

async function commitReplyToAgent(
  op: Extract<PendingOp, { kind: 'reply_to_agent' }>,
  userId: string
): Promise<ToolResult> {
  const { args, agentId } = op;
  const { message, attention_request_id, reject } = args;

  // Re-fetch the agent in case it changed between validate and commit. If it
  // was deleted, surface the error in logs but don't try to recover — the SMS
  // commit is committed by this point.
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId, deletedAt: null },
  });
  if (!agent) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: `Agent ${agentId.substring(0, 6)} no longer exists`,
    };
  }

  log.info('Replying to agent', {
    phase: 'reply',
    agentId: agent.id,
    userId,
    messagePreview: message?.substring(0, 100),
    hasAttentionRequest: !!attention_request_id,
    reject: !!reject,
  });

  // 1. Post USER message to agent's conversation
  try {
    await createMessage({
      agentId: agent.id,
      text: message,
      role: 'USER',
      metadata: { source: 'sms_supervisor' },
    });

    log.info('Posted USER message', {
      phase: 'reply',
      agentId: agent.id,
    });
  } catch (error) {
    log.error('Failed to post message', {
      phase: 'reply',
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: 'Failed to post message to agent',
    };
  }

  // 2. Signal the workflow to unblock any waiting tool
  if (agent.temporalWorkflowId) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      const signalValue = attention_request_id
        ? JSON.stringify({
            request_id: attention_request_id,
            response: reject ? '__REJECTED__' : message,
          })
        : message;
      await handle.signal('receive_user_response', signalValue);

      log.info('Signaled workflow', {
        phase: 'reply',
        workflowId: agent.temporalWorkflowId,
        agentId: agent.id,
        reject: !!reject,
      });
    } catch (error) {
      log.error('Failed to signal workflow', {
        phase: 'reply',
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail — message is in DB, workflow will poll
    }
  }

  // 3. If resolving an attention request, mark it in DB
  if (attention_request_id) {
    try {
      const userResponse = reject ? '__REJECTED__' : message || 'Approved';
      await prisma.agentAttentionRequest.update({
        where: { id: attention_request_id },
        data: { userResponse },
      });

      log.info('Resolved attention request', {
        phase: 'reply',
        requestId: attention_request_id,
        reject: !!reject,
      });
    } catch (error) {
      log.warn('Failed to resolve attention request', {
        phase: 'reply',
        requestId: attention_request_id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail — message is posted, agent will see it
    }
  }

  const action = attention_request_id
    ? reject
      ? 'Rejected request and replied to'
      : 'Approved request and replied to'
    : 'Replied to';
  return {
    tool: 'reply_to_agent',
    success: true,
    result: `${action} agent [${agent.id.substring(0, 6)}]`,
  };
}

async function commitKillAgent(
  op: Extract<PendingOp, { kind: 'kill_agent' }>
): Promise<ToolResult> {
  const { agentId } = op;
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
  });
  if (!agent) {
    // Already deleted — kill is idempotent, treat as success.
    return {
      tool: 'kill_agent',
      success: true,
      result: `Agent [${agentId.substring(0, 6)}] already deleted`,
    };
  }

  log.info('Killing agent', {
    phase: 'kill',
    agentId: agent.id,
    goal: agent.goal.substring(0, 80),
  });

  // Recursive delete (same logic as DELETE /api/agents/:id)
  await deleteAgentRecursive(agent.id);

  log.info('Agent killed', { phase: 'kill', agentId: agent.id });

  return {
    tool: 'kill_agent',
    success: true,
    result: `Killed agent [${agent.id.substring(0, 6)}]: "${agent.goal.substring(0, 50)}"`,
  };
}

async function commitIncreaseBudget(
  op: Extract<PendingOp, { kind: 'increase_budget' }>
): Promise<ToolResult> {
  const { args, agentId } = op;
  const { amount_dollars } = args;

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
  });
  if (!agent) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `Agent ${agentId.substring(0, 6)} no longer exists`,
    };
  }

  const addCents = Math.round(amount_dollars * 100);
  const newLimitCents = agent.priceLimitCents + addCents;

  log.info('Increasing budget', {
    phase: 'budget',
    agentId: agent.id,
    currentLimitCents: agent.priceLimitCents,
    addCents,
    newLimitCents,
    treeCostCents: agent.treeCostCents,
  });

  // Update the agent's price limit
  await prisma.agent.update({
    where: { id: agent.id },
    data: { priceLimitCents: newLimitCents },
  });

  // If agent was cost-limited, signal workflow to resume
  if (agent.status === 'COST_LIMIT_REACHED' && agent.temporalWorkflowId) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('price_limit_increased', {
        new_limit_cents: newLimitCents,
      });
      log.info('Signaled price_limit_increased', {
        phase: 'budget',
        workflowId: agent.temporalWorkflowId,
        newLimitCents,
      });
    } catch (error) {
      log.error('Failed to signal workflow', {
        phase: 'budget',
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    tool: 'increase_budget',
    success: true,
    result: `Budget for [${agent.id.substring(0, 6)}] increased to $${(newLimitCents / 100).toFixed(2)}${agent.status === 'COST_LIMIT_REACHED' ? ' — agent resuming' : ''}`,
  };
}

async function commitStartNewAgent(
  op: Extract<PendingOp, { kind: 'start_new_agent' }>,
  userId: string
): Promise<ToolResult> {
  const { args, provisionalId } = op;
  const { goal, budget_dollars } = args;
  const priceLimitCents = budget_dollars ? Math.round(budget_dollars * 100) : 100;

  log.info('Starting new agent', {
    phase: 'start',
    userId,
    provisionalId,
    goal: goal.substring(0, 100),
    priceLimitCents,
  });

  let agent;
  try {
    agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          // Client-supplied UUID makes commit idempotent: a retried commit
          // would collide on the PK and we catch P2002 below as already-done.
          id: provisionalId,
          userId,
          goal,
          source: 'SMS',
          model: 'rose-labs/rose-1-lite',
          reasoningMaxTokens: 2048,
          status: 'STARTING_UP',
          priceLimitCents,
        },
      });

      await tx.verifier.create({
        data: {
          agentId: newAgent.id,
          type: 'FLOAT_LLM_JUDGE',
        },
      });

      await tx.message.create({
        data: {
          agentId: newAgent.id,
          text: goal,
          role: 'USER',
          timestamp: new Date(),
        },
      });

      return newAgent;
    });
  } catch (error) {
    // P2002 = unique constraint violation. Means this provisional ID was
    // already created — a previous commit fired (the seq gate normally
    // prevents this, but a backend restart mid-flush could rerun us). Treat
    // as already-committed and report the existing agent.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      log.info('start_new_agent commit already done (PK collision)', { provisionalId });
      return {
        tool: 'start_new_agent',
        success: true,
        result: `Agent [${provisionalId.substring(0, 6)}] already started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(provisionalId)}`,
      };
    }
    throw error;
  }

  // Start Temporal workflow
  try {
    const workflowId = await startAgentWorkflow({
      agentId: agent.id,
      userId,
      goal,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 2048,
      verifier: {
        type: 'FLOAT_LLM_JUDGE',
      },
      priceLimitCents,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: workflowId },
    });

    log.info('Agent created and workflow started', {
      phase: 'start',
      agentId: agent.id,
      prefix: agent.id.substring(0, 6),
      workflowId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to start workflow', {
      phase: 'start',
      agentId: agent.id,
      error: errorMsg,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'FAILED', statusMessage: `Failed to start workflow: ${errorMsg}` },
    });

    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: `Failed to start agent workflow: ${errorMsg}`,
    };
  }

  return {
    tool: 'start_new_agent',
    success: true,
    result: `Agent [${agent.id.substring(0, 6)}] started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(agent.id)}`,
  };
}

async function executeWebSearchTool(args: WebSearchArgs): Promise<ToolResult> {
  const { query } = args;

  log.info('Executing web search', { phase: 'search', query });
  const startTime = Date.now();

  const searchResult = await executeWebSearch(query);

  log.info('Search complete', {
    phase: 'search',
    query,
    answerLength: searchResult.answer.length,
    sourceCount: searchResult.sources.length,
    durationMs: Date.now() - startTime,
  });

  return {
    tool: 'web_search',
    success: true,
    result: searchResult.answer,
  };
}

// deleteAgentRecursive moved to supervisorTools.helpers.ts
