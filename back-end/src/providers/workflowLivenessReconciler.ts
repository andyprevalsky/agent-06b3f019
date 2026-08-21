/**
 * Seal agent rows whose Temporal workflow is already closed.
 *
 * Every terminal status write originates INSIDE the workflow
 * (agents/workflows/agent_workflow.py `_mark_failed`/`_mark_complete`). Temporal
 * TERMINATE runs no workflow code and `@workflow.run` has no try/finally, so
 * killing a workflow kills the only observer of its own death. On 2026-08-03 a
 * cleanup script terminated 16 live production workflows; a day later 3 were
 * still ACTIVE, 5 PAUSED, 8 COST_LIMIT_REACHED, and 0 FAILED — a permanent
 * "Thinking" shimmer with resume returning 409 and messages silently dropped.
 * See docs/rca/cases/2026-08-04-no-liveness-reconciler-for-externally-closed-workflows.md
 *
 * `workflowTerminalCleanup.ts` already runs the opposite direction (DB terminal →
 * kill workflow). This is the missing half: workflow closed → seal the DB row.
 *
 * SAFETY: only seal on an AUTHORITATIVE closed reading. A transient Temporal or
 * network error must leave the row untouched — a false positive kills a live
 * agent, which is strictly worse than leaving a stale row for the next tick.
 *
 * 10k agents: one bounded batch per tick, one describe per candidate, bounded
 * concurrency. Work scales with the number of open workflows examined per tick,
 * never with total agent count, and holds no cross-agent shared state.
 */

import { WorkflowNotFoundError } from '@temporalio/client';
import { releaseAgentBrowserSessions } from './agentCleanup';
import { prisma } from './database';
import { createLogger } from './logger';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
} from './staleWorkflowTools';
import { getTemporalClient } from './temporal';

const log = createLogger('WorkflowLivenessReconciler');

/** Statuses that mean the workflow is authoritatively over. */
const CLOSED_TEMPORAL_STATUSES = new Set([
  'TERMINATED',
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
]);

/** Rows in these statuses are already settled and are never touched. */
const TERMINAL_AGENT_STATUSES = ['COMPLETED', 'FAILED'] as const;

/**
 * How long a row must have gone untouched before it is even considered. A
 * healthy agent PATCHes status on every LLM call, so a quiet row is the only
 * thing worth spending a describe on — and the delay keeps a just-started
 * workflow (row written before Temporal reports it) out of scope entirely.
 */
const MIN_QUIET_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 8;

export const RECONCILED_STATUS_MESSAGE =
  'Workflow ended without reporting a result (terminated or lost). Sealed by liveness reconciler.';

export interface LivenessCandidate {
  agentId: string;
  workflowId: string;
  status: string;
}

export interface WorkflowLivenessDependencies {
  /**
   * Authoritative liveness. Return the Temporal status string, or 'NOT_FOUND'
   * when the execution is gone. THROW on an inconclusive read — the caller
   * treats a throw as "leave it alone", never as "closed".
   */
  describeStatus: (workflowId: string) => Promise<string>;
  now: () => number;
  batchSize: number;
  concurrency: number;
  finalizeInterruptedTools: typeof finalizeInterruptedWorkflowTools;
  releaseBrowserSessions: typeof releaseAgentBrowserSessions;
}

function defaultDependencies(): WorkflowLivenessDependencies {
  return {
    describeStatus: async (workflowId: string) => {
      try {
        const handle = (await getTemporalClient()).workflow.getHandle(workflowId);
        const description = await handle.describe();
        return String(description.status.name);
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return 'NOT_FOUND';
        throw error;
      }
    },
    now: () => Date.now(),
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
    releaseBrowserSessions: releaseAgentBrowserSessions,
  };
}

/**
 * Open rows worth checking: not deleted, workflow-backed, not already settled,
 * and quiet long enough that a live agent would have touched them.
 */
export async function findLivenessCandidates(
  deps: Pick<WorkflowLivenessDependencies, 'now' | 'batchSize'>
): Promise<LivenessCandidate[]> {
  const rows = await prisma.agent.findMany({
    where: {
      deletedAt: null,
      temporalWorkflowId: { not: null },
      status: { notIn: [...TERMINAL_AGENT_STATUSES] },
      updatedAt: { lt: new Date(deps.now() - MIN_QUIET_MS) },
    },
    select: { id: true, temporalWorkflowId: true, status: true },
    orderBy: { updatedAt: 'asc' },
    take: deps.batchSize,
  });

  return rows.flatMap((row) =>
    row.temporalWorkflowId === null
      ? []
      : [{ agentId: row.id, workflowId: row.temporalWorkflowId, status: String(row.status) }]
  );
}

/**
 * Seal one agent. Idempotent: the update is conditional on the row still being
 * non-terminal, so a concurrent reconciler or a late in-workflow write wins
 * without producing a second transition.
 */
async function sealAgent(
  candidate: LivenessCandidate,
  temporalStatus: string,
  deps: Pick<WorkflowLivenessDependencies, 'finalizeInterruptedTools' | 'releaseBrowserSessions'>
): Promise<boolean> {
  // Reconcile the generation that actually died — `candidate.workflowId` — not the
  // agent id. They differ for every agent that already survived a deploy
  // (`<agentId>:replacement:<token>`), and chips plus attention requests are both
  // keyed on the generation that wrote them, so defaulting to the agent id silently
  // matched nothing and left the chip IN_PROGRESS and the request pending forever.
  const inProgressTools = await captureInProgressWorkflowTools(
    candidate.agentId,
    candidate.workflowId
  );

  const { count } = await prisma.agent.updateMany({
    where: {
      id: candidate.agentId,
      temporalWorkflowId: candidate.workflowId,
      deletedAt: null,
      status: { notIn: [...TERMINAL_AGENT_STATUSES] },
    },
    data: { status: 'FAILED', statusMessage: RECONCILED_STATUS_MESSAGE },
  });

  if (count === 0) return false;

  // Close dangling IN_PROGRESS chips and open approvals so the UI settles too.
  try {
    await deps.finalizeInterruptedTools(candidate.agentId, candidate.workflowId, inProgressTools);
  } finally {
    // This seal writes the row directly, so it bypasses `updateAgentStatus`'s
    // terminal hook. Cleanup of chips and approvals is best effort with respect
    // to releasing the rented browser: a failure there must never leak a provider
    // session after the row has already been sealed.
    await deps.releaseBrowserSessions(candidate.agentId);
  }
  log.warn('Sealed agent whose workflow was already closed', {
    agentId: candidate.agentId,
    workflowId: candidate.workflowId,
    previousStatus: candidate.status,
    temporalStatus,
  });
  return true;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function reconcileWorkflowLiveness(
  overrides: Partial<WorkflowLivenessDependencies> = {}
): Promise<{ examined: number; sealed: number; inconclusive: number }> {
  const deps = { ...defaultDependencies(), ...overrides };
  const candidates = await findLivenessCandidates(deps);

  let sealed = 0;
  let inconclusive = 0;

  await mapWithConcurrency(candidates, deps.concurrency, async (candidate) => {
    let temporalStatus: string;
    try {
      temporalStatus = await deps.describeStatus(candidate.workflowId);
    } catch (error) {
      // Inconclusive: Temporal unreachable, throttled, or erroring. Leave the row
      // exactly as-is; a live agent must never be sealed on a failed read.
      inconclusive++;
      log.warn('Liveness read inconclusive; leaving agent untouched', {
        agentId: candidate.agentId,
        workflowId: candidate.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const normalized = temporalStatus.replace(/^WORKFLOW_EXECUTION_STATUS_/, '').toUpperCase();
    if (normalized !== 'NOT_FOUND' && !CLOSED_TEMPORAL_STATUSES.has(normalized)) return;

    if (await sealAgent(candidate, normalized, deps)) sealed++;
  });

  if (sealed > 0 || inconclusive > 0) {
    log.info('Workflow liveness reconcile complete', {
      examined: candidates.length,
      sealed,
      inconclusive,
    });
  }
  return { examined: candidates.length, sealed, inconclusive };
}
