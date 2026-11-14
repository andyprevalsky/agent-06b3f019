/** Budget commit: validate amount -> atomic live-agent increment -> report committed limit. */
import { prisma, withoutQueryRetry } from '../database';
import { getTemporalClient } from '../temporal';
import { createLogger } from '../logger';
import { recordMessagingAgentInteraction } from '../messagingAgentInteraction';
import type { PendingOp, ToolResult } from './supervisorTools';

const log = createLogger('SmsSupervisorTools');
/** Ceiling for a single agent price limit, bounded by Prisma Int. */
const MAX_PRICE_LIMIT_CENTS = 100_000_00;

function formatTaskLabel(goal: string, maxLength = 80): string {
  const normalized = goal.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.substring(0, maxLength - 3)}...`
    : normalized;
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

  // Reject non-finite input FIRST and by name. `Math.round(NaN)` is `NaN` and
  // `NaN < 1` is false, so a non-numeric or Infinite amount slips past the
  // sub-cent guard below and is only caught by the safe-integer check further
  // down — which reports "exceeds the maximum" for an input that was never a
  // number, sending the user chasing a limit that is not the problem.
  if (!Number.isFinite(amount_dollars)) {
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error: `Increase amount must be a number, got ${JSON.stringify(amount_dollars)}`,
    };
  }

  // A sub-cent amount rounds to 0 and would report an increase that never
  // happened; an enormous one overflows the Prisma `Int` column and throws
  // AFTER the SMS commit gate.
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

  // Atomic conditional increment. A read-then-write loses a concurrent increase:
  // two commits read the same priceLimitCents and the last update overwrites the
  // other. `commitPendingWrites` only serializes within one invocation, so the
  // ceiling check and the increment must happen in the same database write.
  // `deletedAt: null` must be re-asserted here, not just in the lookup above: a
  // delete landing between the two would otherwise raise a deleted agent's
  // budget and report success.
  // `RETURNING` (rather than updateMany + a follow-up read) so the guard, the
  // increment, and the value we report all come from ONE statement. Reporting
  // the pre-read `newLimitCents` would understate the budget whenever a
  // concurrent increase commits first — and the Temporal signal below would
  // then resume the workflow on a lower limit than the row actually holds.
  const bumpedRows = await withoutQueryRetry(
    () => prisma.$queryRaw<
      Array<{ priceLimitCents: number; status: string; temporalWorkflowId: string | null }>
    >`
    UPDATE "Agent"
    SET "priceLimitCents" = "priceLimitCents" + ${addCents}
    WHERE "id" = ${agent.id}
      AND "deletedAt" IS NULL
      AND "priceLimitCents" <= ${MAX_PRICE_LIMIT_CENTS - addCents}
    RETURNING "priceLimitCents", "status", "temporalWorkflowId"
  `
  );
  if (bumpedRows.length === 0) {
    // Zero rows means the ceiling predicate OR the liveness predicate failed;
    // re-read to report the accurate reason instead of always blaming the cap.
    const current = await prisma.agent.findFirst({
      where: { id: agent.id, deletedAt: null },
      select: { id: true },
    });
    return {
      tool: 'increase_budget',
      success: false,
      result: '',
      error:
        current === null
          ? 'Agent no longer exists'
          : `Resulting budget exceeds the $${(MAX_PRICE_LIMIT_CENTS / 100).toFixed(2)} maximum`,
    };
  }

  await recordMessagingAgentInteraction(agent.id, 'increase_budget');

  // The authoritative committed limit, not the pre-read projection.
  const {
    priceLimitCents: committedLimitCents,
    status: committedStatus,
    temporalWorkflowId: committedWorkflowId,
  } = bumpedRows[0];

  // Report the committed budget independently from the resume signal outcome.
  let resumeSignaled = false;
  // If agent was cost-limited, signal workflow to resume
  if (committedStatus === 'COST_LIMIT_REACHED' && committedWorkflowId) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(committedWorkflowId);
      await handle.signal('price_limit_increased', {
        new_limit_cents: committedLimitCents,
      });
      resumeSignaled = true;
      log.info('Signaled price_limit_increased', {
        phase: 'budget',
        workflowId: committedWorkflowId,
        newLimitCents: committedLimitCents,
      });
    } catch (error) {
      log.error('Failed to signal workflow', {
        phase: 'budget',
        workflowId: committedWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    tool: 'increase_budget',
    success: true,
    result: `Budget increased to $${(committedLimitCents / 100).toFixed(2)} for [${agent.id.substring(0, 6)}] "${formatTaskLabel(agent.goal)}"${committedStatus === 'COST_LIMIT_REACHED' ? (resumeSignaled ? ' — agent resuming' : ' — agent not resumed') : ''}`,
  };
}
