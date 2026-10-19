import { isWorkflowStartAdmissionPending } from '../workflowQueueAdmission';
/**
 * SMS supervisor start_new_agent commit + web_search execution.
 * Split from supervisorTools.ts to stay under max-lines.
 */

import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import {
  reconcileWorkflowStart,
  startAgentWorkflowExecution,
  type TemporalWorkflowExecutionRef,
} from '../temporal';
import { recordAgentWorkflowExecution } from '../workflowGeneration';
import { terminateStaleTemporalWorkflow } from '../workflowReplacement';
import { getAgentUrl } from '../smsTemplates';
import { createLogger } from '../logger';
import type { FilePointer } from '../storage';
import type { SupervisorChannel } from './channelDelivery';
import { plannerMemoryEnabledByDefault } from '../plannerMemoryDefaults';

const log = createLogger('SmsSupervisorTools');

interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

export type StartPhase = 'plan' | 'execute';

export interface StartNewAgentArgs {
  goal: string;
  notification_message?: string | null;
  budget_dollars?: number;
  start_phase?: StartPhase | null;
}

export interface WebSearchArgs {
  query: string;
}

/**
 * The agent row disappeared (or another start won) between the workflow start
 * and recording its identity. Close the started run here: no cleanup
 * obligation exists for a row that never carried this Workflow ID.
 */
async function closeRunOfRemovedAgent(
  startedAgentId: string,
  displayId: string,
  execution: TemporalWorkflowExecutionRef
) {
  log.warn('Started workflow was superseded before its run identity was recorded', {
    phase: 'start',
    agentId: startedAgentId,
    workflowId: execution.workflowId,
    firstExecutionRunId: execution.firstExecutionRunId,
  });
  try {
    await terminateStaleTemporalWorkflow(execution, startedAgentId);
  } catch (error) {
    log.error('Failed to close the started workflow of a removed agent', {
      phase: 'start',
      agentId: startedAgentId,
      workflowId: execution.workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    tool: 'start_new_agent',
    success: false,
    result: '',
    error: `Agent [${displayId.substring(0, 6)}] was removed before its workflow started`,
  };
}

export async function commitStartNewAgent(
  op: { kind: 'start_new_agent'; args: StartNewAgentArgs; provisionalId: string },
  userId: string,
  channel: SupervisorChannel = 'SMS',
  attachments: readonly FilePointer[] = [],
  onAgentAllocated?: (agentId: string) => void
): Promise<ToolResult> {
  const { args, provisionalId } = op;
  const { goal, budget_dollars } = args;
  const priceLimitCents = budget_dollars ? Math.round(budget_dollars * 100) : 100;
  const startPhase: StartPhase = args.start_phase ?? 'plan';
  const reportAllocation = (agentId: string): void => {
    try {
      onAgentAllocated?.(agentId);
    } catch (error) {
      log.warn('SMS allocation audit failed', { agentId, error: String(error) });
    }
  };

  log.info('Starting new agent', {
    phase: 'start',
    userId,
    provisionalId,
    goal: goal.substring(0, 100),
    priceLimitCents,
    startPhase,
    attachmentCount: attachments.length,
  });

  let agent: { id: string; fastModeCacheEnabled?: boolean; memoryEnabled?: boolean } | undefined;
  try {
    agent = await runTransactionWithRetry(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          // Client-supplied UUID makes commit idempotent: a retried commit
          // would collide on the PK and we catch P2002 below as already-done.
          id: provisionalId,
          userId,
          goal,
          source: channel,
          model: 'rose-labs/rose-1-flash',
          reasoningMaxTokens: 2048,
          status: 'STARTING_UP',
          priceLimitCents,
          workflowStartPhase: startPhase,
          // Match POST /api/agents default: Fast Mode on so Rose complete
          // calls get provider_fast_mode via the agent flag trickle-down.
          fastModeCacheEnabled: true,
          // Production SMS-created agents follow the product default. Dedicated
          // benchmark stacks stay memory-off to keep evals history-independent.
          memoryEnabled: plannerMemoryEnabledByDefault(),
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
          metadata: {
            startNotification: { message: args.notification_message?.trim() || "I'm on it." },
          },
        },
      });

      // Same attachment-message contract as POST /api/agents createAttachmentMessages.
      for (const attachment of attachments) {
        await tx.message.create({
          data: {
            agentId: newAgent.id,
            text: '',
            role: 'USER',
            timestamp: new Date(),
            filePointer: attachment as unknown as Prisma.JsonObject,
          },
        });
      }

      return newAgent;
    });
    reportAllocation(agent.id);
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
        select: {
          id: true,
          userId: true,
          temporalWorkflowId: true,
          status: true,
          fastModeCacheEnabled: true,
          memoryEnabled: true,
        },
      });
      if (!existing || existing.userId !== userId) {
        log.error('start_new_agent P2002 without a committed agent row', { provisionalId });
        throw error;
      }
      reportAllocation(existing.id);
      // The row existing is not the same as the agent RUNNING. If the previous
      // attempt committed the transaction and died before the workflow start,
      // the agent sits in STARTING_UP with no temporalWorkflowId forever. Fall
      // through and (re)start the workflow rather than reporting success for an
      // agent nothing is driving; the workflow start is itself idempotent on
      // workflow id.
      if (
        existing.temporalWorkflowId === null ||
        existing.temporalWorkflowId === undefined ||
        existing.temporalWorkflowId === ''
      ) {
        log.warn('start_new_agent found a committed agent with no workflow; resuming startup', {
          provisionalId,
          status: existing.status,
        });
        // Adopt the committed row so the workflow start below drives the agent
        // that actually exists. Keep the row's Fast Mode flag so recovery and
        // workflow args stay aligned (pre-migration rows may still be false).
        agent = {
          id: existing.id,
          fastModeCacheEnabled: existing.fastModeCacheEnabled,
          memoryEnabled: existing.memoryEnabled,
        };
      } else {
        log.info('start_new_agent commit already done (PK collision)', { provisionalId });
        return {
          tool: 'start_new_agent',
          success: true,
          result: `Agent [${provisionalId.substring(0, 6)}] already started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(provisionalId)}`,
        };
      }
    } else {
      throw error;
    }
  }

  if (!agent) {
    throw new Error(`start_new_agent could not resolve an agent row for ${provisionalId}`);
  }
  const startedAgent = agent;
  // Prefer the persisted row value (create path + P2002 recovery); default on.
  const resolvedFastMode =
    'fastModeCacheEnabled' in startedAgent && typeof startedAgent.fastModeCacheEnabled === 'boolean'
      ? startedAgent.fastModeCacheEnabled
      : true;
  const resolvedMemory =
    'memoryEnabled' in startedAgent && typeof startedAgent.memoryEnabled === 'boolean'
      ? startedAgent.memoryEnabled
      : plannerMemoryEnabledByDefault();

  // Start Temporal workflow
  try {
    const execution = await startAgentWorkflowExecution({
      agentId: startedAgent.id,
      userId,
      goal,
      model: 'rose-labs/rose-1-flash',
      reasoningMaxTokens: 2048,
      verifier: {
        type: 'FLOAT_LLM_JUDGE',
      },
      startPhase,
      priceLimitCents,
      fastModeCacheEnabled: resolvedFastMode,
      memoryEnabled: resolvedMemory,
    });

    // The row has no Workflow ID until this record, so a deletion in between
    // leaves no cleanup obligation; the started run must be closed here.
    if (!(await recordAgentWorkflowExecution(startedAgent.id, execution))) {
      return closeRunOfRemovedAgent(startedAgent.id, agent.id, execution);
    }
    const workflowId = execution.workflowId;

    log.info('Agent created and workflow started', {
      phase: 'start',
      agentId: startedAgent.id,
      prefix: startedAgent.id.substring(0, 6),
      workflowId,
    });
  } catch (error) {
    if (isWorkflowStartAdmissionPending(error)) {
      return {
        tool: 'start_new_agent',
        success: false,
        result: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to start workflow', {
      phase: 'start',
      agentId: startedAgent.id,
      error: errorMsg,
    });

    // The start is AMBIGUOUS, not necessarily failed: Temporal may have accepted
    // the workflow and the throw happened afterwards (response lost, or the
    // follow-up row write failed). The workflow id IS the agent id, so ask
    // Temporal before declaring failure — otherwise a live workflow keeps
    // running against an agent row marked FAILED.
    const reconciled = await reconcileWorkflowStart(startedAgent.id);
    if (reconciled.kind === 'live') {
      log.warn('Workflow start reported an error but the workflow is live; adopting it', {
        phase: 'start',
        agentId: startedAgent.id,
        workflowStatus: reconciled.status,
        error: errorMsg,
      });
      if (reconciled.firstExecutionRunId === null) {
        await prisma.agent.update({
          where: { id: startedAgent.id },
          data: { temporalWorkflowId: startedAgent.id },
        });
      } else {
        const adopted = {
          workflowId: startedAgent.id,
          firstExecutionRunId: reconciled.firstExecutionRunId,
        };
        if (!(await recordAgentWorkflowExecution(startedAgent.id, adopted))) {
          return closeRunOfRemovedAgent(startedAgent.id, agent.id, adopted);
        }
      }
      return {
        tool: 'start_new_agent',
        success: true,
        result: `Agent [${agent.id.substring(0, 6)}] started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(agent.id)}`,
      };
    }

    // A failed LOOKUP is not evidence of absence. Writing FAILED here would
    // bury a workflow that is actually running behind a transient Temporal
    // error, which is the same orphan this reconciliation exists to prevent.
    // Leave the agent's status untouched so startup stays retryable.
    if (reconciled.kind === 'lookup_failed') {
      log.error('Workflow start outcome is indeterminate; leaving agent status unchanged', {
        phase: 'start',
        agentId: startedAgent.id,
        startError: errorMsg,
        lookupError: reconciled.error,
      });
      return {
        tool: 'start_new_agent',
        success: false,
        result: '',
        error:
          `Could not confirm whether agent [${agent.id.substring(0, 6)}] started ` +
          `(Temporal lookup failed: ${reconciled.error}). Left pending rather than ` +
          `marked failed; check its status before retrying.`,
      };
    }

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
