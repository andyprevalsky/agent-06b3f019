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

import { prisma } from '../database';
import { createMessage } from '../messages';
import { recordPersonMessage } from '../personMessageStamp';
import {
  recordMessagingAgentInteraction,
  SMS_SUPERVISOR_MESSAGE_SOURCE,
} from '../messagingAgentInteraction';
import { createLogger } from '../logger';
import { deleteAgentRecursive } from '../agentKill';
import { deliverUserMessageToWorkflow } from '../agentResume';
import { resolveAgentTarget, unknownSupervisorToolError } from './supervisorTools.helpers';
import { executeGrepTool, GrepArgs } from './supervisorTools.grep';
import { commitStartNewAgent, type StartNewAgentArgs } from './supervisorTools.startAgent';
import type { SupervisorChannel } from './channelDelivery';
import type { FilePointer } from '../storage';
// web_search MUST come from supervisorTools.webSearch: it is the only copy that
// honours BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE. A fixture-blind copy silently
// runs a LIVE search underneath a benchmark whose whole purpose is controlling
// what the model learns, so the run scores a trajectory nobody chose — the
// closed-store task ordered from a restaurant whose closure it was never shown.
import { executeWebSearchTool, type WebSearchArgs } from './supervisorTools.webSearch';
import {
  agentNeedsCutoverRecovery,
  formatReplyToAgentAction,
  isDeploymentSealedWorkflowId,
  recoverCutoverKilledAgent,
} from '../generationQueueCutover';
import { DEPLOY_INTERRUPTED_TOOL_MESSAGE } from '../workflowGeneration';
import { commitIncreaseBudget } from './supervisorTools.budget';
import { SmsSupervisorToolCallSchema } from './schema';
import { nativePhoneReplyRefusal } from './nativePhoneReply';

const log = createLogger('SmsSupervisorTools');

export { TOOL_SCHEMAS } from './supervisorTools.schemas';

// ============================================
// Tool Call Type
// ============================================

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  /** Provider tool-call id on the native path; replayed in the next round's history. */
  id?: string;
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

// ============================================
// Prefix Resolution Helper
// ============================================

// resolveAgentTarget / resolveAgentPrefix live in supervisorTools.helpers.ts
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

  const loggedArgs =
    tool === 'reply_to_agent'
      ? { hasAttentionRequest: args.attention_request_id !== undefined }
      : args;
  log.info('Dispatching tool', { tool, args: JSON.stringify(loggedArgs), userId });

  try {
    const parsed = SmsSupervisorToolCallSchema.safeParse(toolCall);
    // Existing executors own omitted/null defaults and value-level validation.
    if (
      !parsed.success &&
      parsed.error.issues.some(
        (issue) =>
          issue.code === 'invalid_type' &&
          issue.received !== 'undefined' &&
          issue.received !== 'null'
      )
    ) {
      return { tool, success: false, result: '', error: parsed.error.message };
    }

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
      args: JSON.stringify(loggedArgs),
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
  userId: string,
  channel: SupervisorChannel = 'SMS',
  /** Current-turn inbound MMS FilePointers — auto-forwarded onto start_new_agent. */
  inboundAttachments: readonly FilePointer[] = [],
  onAgentAllocated?: (agentId: string) => void
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
          result = await commitStartNewAgent(
            op,
            userId,
            channel,
            inboundAttachments,
            onAgentAllocated
          );
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
  const agent = await resolveAgentTarget(args.agent_id_or_prefix, userId, pendingWrites);
  if (!agent) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: `No agent found matching "${args.agent_id_or_prefix}"`,
    };
  }
  const refusal = await nativePhoneReplyRefusal(userId, agent.id, args.attention_request_id);
  if (refusal) return refusal;
  // A rejection is only expressible as a resolved attention request: without an
  // `attention_request_id` the commit signals the bare `message`, which
  // `receive_user_response` reads as ordinary feedback. Accepting this pair
  // would silently downgrade a "no" into a "here's a comment" and let the
  // blocked tool proceed as if it had never been refused.
  if (args.reject === true && args.attention_request_id === undefined) {
    return {
      tool: 'reply_to_agent',
      success: false,
      result: '',
      error: 'Rejecting requires the attention_request_id of the request being rejected',
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
  const agent = await resolveAgentTarget(args.agent_id_or_prefix, userId, pendingWrites);
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
  const agent = await resolveAgentTarget(args.agent_id_or_prefix, userId, pendingWrites);
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
  if (
    args.notification_message !== undefined &&
    args.notification_message !== null &&
    typeof args.notification_message !== 'string'
  )
    throw new Error('notification_message must be a string or null');
  if (
    args.start_phase !== undefined &&
    args.start_phase !== null &&
    args.start_phase !== 'plan' &&
    args.start_phase !== 'execute'
  ) {
    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: `start_phase must be 'plan' or 'execute', got ${JSON.stringify(args.start_phase)}`,
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

  const refusal = await nativePhoneReplyRefusal(userId, agent.id, attention_request_id);
  if (refusal) return refusal;

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
      metadata: { source: SMS_SUPERVISOR_MESSAGE_SOURCE },
    }).then(recordPersonMessage);
    await recordMessagingAgentInteraction(agent.id, 'reply_to_agent');

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

  // ONE canonical response for both sinks. These used to diverge: the signal
  // sent a bare empty `message` while the row persisted the 'Approved' default,
  // so on an empty approval the database recorded a decision the workflow never
  // received.
  const canonicalUserResponse = reject ? '__REJECTED__' : message || 'Approved';

  // 2. Signal the workflow to unblock any waiting tool.
  // A deployment-sealed id is a tombstone, not a running execution — the
  // Temporal signal can only 404 (prod agent 3eb6da5a, late approve 13:00Z).
  if (agent.temporalWorkflowId && !isDeploymentSealedWorkflowId(agent.temporalWorkflowId)) {
    const signalValue = attention_request_id
      ? JSON.stringify({
          request_id: attention_request_id,
          response: canonicalUserResponse,
        })
      : message;
    // Never fails the reply: the message is in DB and the workflow polls for it.
    const { signaled } = await deliverUserMessageToWorkflow(
      agent.id,
      agent.temporalWorkflowId,
      signalValue
    );
    if (signaled) {
      log.info('Signaled workflow', {
        phase: 'reply',
        workflowId: agent.temporalWorkflowId,
        agentId: agent.id,
        reject: !!reject,
      });
    }
  }

  // 3. If resolving an attention request, mark it in DB
  let attentionResolved = false;
  if (attention_request_id) {
    try {
      const userResponse = canonicalUserResponse;
      // Scope by agent AND user, not request id alone. validateReplyToAgent
      // accepts any attention_request_id when currentSmsMatches is true, so an
      // id belonging to another agent or user would otherwise be written here.
      // `userResponse: null` keeps this single-shot. Without it a repeated
      // reply overwrites an existing decision and reports a fresh
      // approval/rejection for a request that was already resolved.
      const resolved = await prisma.agentAttentionRequest.updateMany({
        where: { id: attention_request_id, agentId: agent.id, userId, userResponse: null },
        data: { userResponse },
      });
      attentionResolved = resolved.count > 0;
      if (!attentionResolved) {
        log.warn('Attention request not resolved: not owned by this agent/user', {
          phase: 'reply',
          requestId: attention_request_id,
          agentId: agent.id,
        });
      } else {
        log.info('Resolved attention request', {
          phase: 'reply',
          requestId: attention_request_id,
          reject: !!reject,
        });
      }
    } catch (error) {
      log.warn('Failed to resolve attention request', {
        phase: 'reply',
        requestId: attention_request_id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail — message is posted, agent will see it
    }
  }

  // A deploy-fenced approval or cutover-FAILED/sealed agent cannot consume a
  // Temporal signal. Restart so a late approve is not a dead-end.
  let recoveredCutover = false;
  const attention = attention_request_id
    ? await prisma.agentAttentionRequest.findFirst({
        where: { id: attention_request_id, agentId: agent.id, userId },
        select: { userResponse: true },
      })
    : null;
  const fencedApproval = attention?.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE;
  if (agentNeedsCutoverRecovery(agent) || (fencedApproval && !attentionResolved)) {
    recoveredCutover = await recoverCutoverKilledAgent(agent.id);
    if (recoveredCutover) {
      log.info('Restarted cutover-killed agent after late approval', {
        phase: 'reply',
        agentId: agent.id,
        requestId: attention_request_id,
      });
    }
  }

  const action = formatReplyToAgentAction({
    recoveredCutover,
    reject: !!reject,
    attentionRequestId: attention_request_id,
    attentionResolved,
  });
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

  // Recursive delete — same canonical path as DELETE /api/agents/:id (UI Archive)
  await deleteAgentRecursive(agent.id, { terminateReason: 'Agent killed via SMS' });

  log.info('Agent killed', { phase: 'kill', agentId: agent.id });

  return {
    tool: 'kill_agent',
    success: true,
    result: `Killed agent [${agent.id.substring(0, 6)}]: "${agent.goal.substring(0, 50)}"`,
  };
}

// commitStartNewAgent + executeWebSearchTool live in supervisorTools.startAgent.ts

// deleteAgentRecursive lives in providers/agentKill.ts (shared with UI Archive)
