/**
 * SMS Supervisor Tools
 *
 * 9 tools available to the SMS supervisor LLM:
 * 1. reply_to_agent — Send a reply to an agent (answers questions, approves/rejects write-locks)
 * 2. kill_agent — Terminate an agent and all sub-agents
 * 3. increase_budget — Increase an agent's cost limit
 * 4. start_new_agent — Create and start a new agent
 * 5. web_search — Search the web for information
 * 6. grep — Search the user's local data (messages, network, transactions, documents)
 * 7. get_environment — Refresh runtime agent/environment state
 * 8. send_user_message — Send an SMS without ending the run
 * 9. attempt_completion — End a run after at least one successful send
 *
 * Each tool has a JSON schema for the LLM and an executor function.
 * All executors log extensively at boundaries.
 */

import { randomUUID } from 'node:crypto';

import { executeWebSearch } from '../chat/chatTools';
import { createLogger } from '../logger';
import {
  resolveAgentPrefix,
  smsIntendsAgentReply,
  unknownSupervisorToolError,
} from './supervisorTools.helpers';
import { executeGrepTool, GrepArgs } from './supervisorTools.grep';
export type {
  ToolCall,
  ToolResult,
  ToolInvocationContext,
  PendingOp,
} from './supervisorTools.types';
import type {
  ToolCall,
  ToolResult,
  ToolInvocationContext,
  PendingOp,
  ReplyToAgentArgs,
  KillAgentArgs,
  IncreaseBudgetArgs,
  StartNewAgentArgs,
} from './supervisorTools.types';
import {
  commitReplyToAgent,
  commitKillAgent,
  commitIncreaseBudget,
  commitStartNewAgent,
} from './supervisorTools.commits';

const log = createLogger('SmsSupervisorTools');

export { TOOL_SCHEMAS } from './supervisorTools.schemas';

// ============================================
// Tool Call Type
// ============================================

// Per-tool argument types (validated upstream via JSON schema)

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
// to a per-run `PendingOp[]` buffer. The supervisor handler flushes that buffer
// immediately before the next user-visible send, or as a final flush when an
// already-messaged run terminates. Every flush first re-checks that no newer
// inbound SMS arrived. If the gate denies the commit, no side effect fires.
//
// This gives us:
//   - Natural debounce: a follow-up SMS while a run is mid-flight invalidates
//     the queued writes; only the latest run produces side effects + reply.
//   - Ordered user visibility: queued ops are applied before the SMS that
//     reports their outcome.
//   - Idempotency without per-tool rollback: writes never run speculatively,
//     so there's nothing to undo on abort.

/**
 * Tool dispatcher used inside the supervisor loop. Read tools execute inline;
 * write tools validate args, push a {@link PendingOp} onto `pendingWrites`,
 * and return a synthetic "queued" tool_result so the model can keep reasoning.
 */
export async function dispatchToolCall(
  toolCall: ToolCall,
  userId: string,
  pendingWrites: PendingOp[],
  invocationContext?: ToolInvocationContext
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
          pendingWrites,
          invocationContext
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
      case 'grep':
        result = await executeGrepTool(args as unknown as GrepArgs, userId);
        break;
      case 'attempt_completion':
        // Loop terminator — the handler intercepts before reaching this point.
        result = { tool, success: true, result: 'Completion signaled' };
        break;
      case 'send_user_message':
        // Delivery needs run sequence + phone context, so the handler owns it.
        result = { tool, success: false, result: '', error: 'Delivery context unavailable' };
        break;
      case 'get_environment':
        // Context construction lives in the handler to avoid a dispatcher cycle.
        result = { tool, success: false, result: '', error: 'Environment context unavailable' };
        break;
      default:
        result = { tool, success: false, result: '', error: unknownSupervisorToolError(tool) };
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
  pendingWrites: PendingOp[],
  invocationContext?: ToolInvocationContext
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
  const attentionMatches =
    args.attention_request_id !== undefined &&
    invocationContext?.pendingAttentionRequestIds.includes(args.attention_request_id) === true;
  const currentSmsMatches =
    invocationContext !== undefined &&
    smsIntendsAgentReply({
      currentUserMessage: invocationContext.currentUserMessage,
      visibleSessionHistory: invocationContext.visibleSessionHistory,
      agentGoal: agent.goal,
    });
  if (!attentionMatches && !currentSmsMatches) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: 'Current SMS does not identify this agent task or a matching pending request',
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

/** Agent-run LLM/tool budget ceiling on the SMS surface (not purchase amount). */
const MAX_SMS_AGENT_RUN_BUDGET_DOLLARS = 2;

function validateStartNewAgent(args: StartNewAgentArgs, pendingWrites: PendingOp[]): ToolResult {
  if (!args.goal || typeof args.goal !== 'string' || args.goal.trim().length === 0) {
    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: 'goal is required and must be a non-empty string',
    };
  }
  if (args.budget_dollars !== undefined) {
    if (!Number.isFinite(args.budget_dollars) || args.budget_dollars <= 0) {
      return {
        tool: 'start_new_agent',
        success: false,
        result: '',
        error: `budget_dollars must be a positive number, got ${args.budget_dollars}`,
      };
    }
    if (args.budget_dollars > MAX_SMS_AGENT_RUN_BUDGET_DOLLARS) {
      return {
        tool: 'start_new_agent',
        success: false,
        result: '',
        error:
          `budget_dollars is the agent-run LLM/tool budget (default $1, max $${MAX_SMS_AGENT_RUN_BUDGET_DOLLARS}), ` +
          'NOT the purchase price. Purchases are approved separately via attention requests. ' +
          `Retry with budget_dollars <= ${MAX_SMS_AGENT_RUN_BUDGET_DOLLARS}.`,
      };
    }
  }
  const provisionalId = randomUUID();
  pendingWrites.push({ kind: 'start_new_agent', args, provisionalId });
  return {
    tool: 'start_new_agent',
    success: true,
    result: `queued: will start agent [${provisionalId.substring(0, 6)}] for "${args.goal.substring(0, 80)}"`,
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
