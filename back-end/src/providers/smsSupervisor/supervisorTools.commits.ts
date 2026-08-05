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

import { prisma } from '../database';
import { startAgentWorkflow, getTemporalClient } from '../temporal';
import { getAgentUrl } from '../smsTemplates';
import { createMessage } from '../messages';
import { createLogger } from '../logger';
import { deleteAgentRecursive } from './supervisorTools.helpers';
import { formatTaskLabel, type PendingOp, type ToolResult } from './supervisorTools.types';

const log = createLogger('SmsSupervisorCommits');

/** Ceiling for a single agent's price limit; keeps newLimitCents inside Prisma's Int column. */
const MAX_PRICE_LIMIT_CENTS = 100_000_00;

// ============================================
// Commit Implementations — run inside the commit gate, exactly once per run
// ============================================

export async function commitReplyToAgent(
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
      // Scope by agent AND user, not request id alone. validateReplyToAgent
      // accepts any attention_request_id when currentSmsMatches is true, so an
      // id belonging to another agent or user would otherwise be written here —
      // recording an approval its real owner never gave.
      const resolved = await prisma.agentAttentionRequest.updateMany({
        where: { id: attention_request_id, agentId: agent.id, userId },
        data: { userResponse },
      });
      if (resolved.count === 0) {
        log.warn('Attention request not resolved: not owned by this agent/user', {
          phase: 'reply',
          requestId: attention_request_id,
          agentId: agent.id,
        });
      }

      log.info('Resolved attention request', {
        phase: 'reply',
        requestId: attention_request_id,
        resolvedCount: resolved.count,
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

export async function commitKillAgent(
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

export async function commitIncreaseBudget(
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

  // A sub-cent amount rounds to 0 and would report an increase that never
  // happened; an enormous one overflows the Prisma `Int` column and throws
  // AFTER the SMS commit gate. Bound both ends here.
  const addCents = Math.round(amount_dollars * 100);
  if (addCents < 1) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `Increase of $${amount_dollars} rounds to $0.00; use at least $0.01`,
    };
  }
  const newLimitCents = agent.priceLimitCents + addCents;
  if (!Number.isSafeInteger(newLimitCents) || newLimitCents > MAX_PRICE_LIMIT_CENTS) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `Resulting budget exceeds the $${(MAX_PRICE_LIMIT_CENTS / 100).toFixed(2)} maximum`,
    };
  }

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
  let signalDelivered = true;
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
      signalDelivered = false;
      log.error('Failed to signal workflow', {
        phase: 'budget',
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A cost-limited agent whose price_limit_increased signal never landed stays
  // paused. Reporting "agent resuming" there tells the supervisor LLM the job is
  // done, so it never retries or tells the user.
  const wasCostLimited = agent.status === 'COST_LIMIT_REACHED';
  const resumeNote = wasCostLimited
    ? signalDelivered
      ? ' — agent resuming'
      : ' — agent still paused: resume signal failed, retry or notify the user'
    : '';

  return {
    tool: 'increase_budget',
    success: true,
    result: `Budget increased to $${(newLimitCents / 100).toFixed(2)} for [${agent.id.substring(0, 6)}] "${formatTaskLabel(agent.goal)}"${resumeNote}`,
  };
}

export async function commitStartNewAgent(
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
      // P2002 names neither the model nor the constraint, and this transaction
      // creates Agent, Verifier and Message. A collision on any of them rolls
      // the whole transaction back, so reporting success here could hand the
      // user a tracking link for an agent that does not exist.
      const existing = await prisma.agent.findUnique({
        where: { id: provisionalId },
        select: { id: true },
      });
      if (!existing) {
        log.error('start_new_agent P2002 without a committed agent row', { provisionalId });
        throw error;
      }
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
