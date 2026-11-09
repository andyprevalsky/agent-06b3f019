import {
  hasUnacknowledgedWorkflowStart,
  updateAgentUnlessStartPending,
  workflowStartMembership,
} from './workflowStartPending';
/**
 * Seal agent rows whose Temporal workflow is already closed, and chat-mode rows
 * whose escalation never started a workflow.
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
 * Chat create is fire-and-forget (`handleChatMessage`). After
 * start_superintelligence the row stays ACTIVE with a null workflow until
 * Temporal acceptance. If persist/start hangs, the catch that fails the agent
 * never runs — prod a7463bcc sat ACTIVE + messageCount 0 + no Cloud Agent chip
 * while the FE treated that as live work. The 2026-08-04 job only selected
 * `temporalWorkflowId not null`, so chat-mode zombies were invisible.
 *
 * `workflowTerminalCleanup.ts` already runs the opposite direction (DB terminal →
 * kill workflow). This is the missing half: workflow closed → seal the DB row,
 * and quiet chat escalation with no workflow → seal the DB row.
 *
 * SAFETY: only seal on an AUTHORITATIVE closed reading. A transient Temporal or
 * network error must leave the row untouched — a false positive kills a live
 * agent, which is strictly worse than leaving a stale row for the next tick.
 * Stuck-chat seals require ACTIVE + null workflow + messageCount 0 + the same
 * quiet window; a finished chat turn writes messageCount > 0 and is left alone.
 *
 * 10k agents: one bounded batch per tick for each candidate class, one describe
 * per workflow-backed candidate, bounded concurrency. Work scales with the
 * number of quiet candidates examined per tick, never with total agent count,
 * and holds no cross-agent shared state.
 */

import type { AgentStatus } from '@prisma/client';
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

export const STUCK_CHAT_STATUS_MESSAGE =
  'Chat escalation never started a workflow. Sealed by liveness reconciler.';

export interface LivenessCandidate {
  agentId: string;
  workflowId: string;
  firstExecutionRunId: string | null;
  replacementToken: string | null;
  status: AgentStatus;
  statusMessage: string | null;
}

export interface StuckChatCandidate {
  agentId: string;
  status: AgentStatus;
  statusMessage: string | null;
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
    select: {
      id: true,
      temporalWorkflowId: true,
      temporalFirstExecutionRunId: true,
      workflowReplacementToken: true,
      status: true,
      statusMessage: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: deps.batchSize,
  });

  return rows.flatMap((row) =>
    row.temporalWorkflowId === null
      ? []
      : [
          {
            agentId: row.id,
            workflowId: row.temporalWorkflowId,
            firstExecutionRunId: row.temporalFirstExecutionRunId,
            replacementToken: row.workflowReplacementToken,
            status: row.status,
            statusMessage: row.statusMessage,
          },
        ]
  );
}

/**
 * Chat-mode rows that never left the pre-workflow escalation window.
 *
 * Finished chat turns persist messageCount > 0 and stay ACTIVE with a null
 * workflow on purpose. Only a quiet ACTIVE row that never recorded a turn
 * (the hung start_superintelligence shape) is a candidate.
 */
export async function findStuckChatCandidates(
  deps: Pick<WorkflowLivenessDependencies, 'now' | 'batchSize'>
): Promise<StuckChatCandidate[]> {
  const rows = await prisma.agent.findMany({
    where: {
      deletedAt: null,
      temporalWorkflowId: null,
      status: 'ACTIVE',
      messageCount: 0,
      updatedAt: { lt: new Date(deps.now() - MIN_QUIET_MS) },
    },
    select: { id: true, status: true, statusMessage: true },
    orderBy: { updatedAt: 'asc' },
    take: deps.batchSize,
  });

  return rows.map((row) => ({
    agentId: row.id,
    status: row.status,
    statusMessage: row.statusMessage,
  }));
}

/**
 * Seal one agent. Idempotent: the update is conditional on the row still being
 * non-terminal, so a concurrent reconciler or a late in-workflow write wins
 * without producing a second transition.
 */
async function sealAgent(
  candidate: LivenessCandidate,
  temporalStatus: string,
  deps: Pick<WorkflowLivenessDependencies, 'finalizeInterruptedTools' | 'releaseBrowserSessions'>,
  membership: string
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

  const { count } = await updateAgentUnlessStartPending(
    candidate.agentId,
    candidate.workflowId,
    temporalStatus,
    {
      where: {
        id: candidate.agentId,
        temporalWorkflowId: candidate.workflowId,
        temporalFirstExecutionRunId: candidate.firstExecutionRunId,
        workflowReplacementToken: candidate.replacementToken,
        deletedAt: null,
        status: { notIn: [...TERMINAL_AGENT_STATUSES] },
      },
      data: { status: 'FAILED', statusMessage: RECONCILED_STATUS_MESSAGE },
    },
    membership
  );

  if (count === 0) return false;

  // Close dangling IN_PROGRESS chips and open approvals so the UI settles too.
  // If any terminal cleanup fails, put the exact row we sealed back into its
  // prior nonterminal state. The next quiet-window scan can then retry instead
  // of permanently excluding unresolved tools or attention requests.
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await deps.finalizeInterruptedTools(candidate.agentId, candidate.workflowId, inProgressTools);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  try {
    // This seal writes the row directly, so it bypasses `updateAgentStatus`'s
    // terminal hook. Always attempt provider cleanup even when tool cleanup
    // rejects, so a failed message append cannot leak a rented browser session.
    await deps.releaseBrowserSessions(candidate.agentId);
  } catch (error) {
    if (cleanupFailed) {
      log.warn('Browser cleanup also failed after interrupted-tool cleanup rejected', {
        agentId: candidate.agentId,
        workflowId: candidate.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (cleanupFailed) {
    const restored = await prisma.agent.updateMany({
      where: {
        id: candidate.agentId,
        temporalWorkflowId: candidate.workflowId,
        deletedAt: null,
        status: 'FAILED',
        statusMessage: RECONCILED_STATUS_MESSAGE,
      },
      data: { status: candidate.status, statusMessage: candidate.statusMessage },
    });
    if (restored.count === 0) {
      log.error('Could not restore liveness row after terminal cleanup failed', {
        agentId: candidate.agentId,
        workflowId: candidate.workflowId,
      });
    }
    throw cleanupError;
  }
  log.warn('Sealed agent whose workflow was already closed', {
    agentId: candidate.agentId,
    workflowId: candidate.workflowId,
    previousStatus: candidate.status,
    temporalStatus,
  });
  return true;
}

/**
 * Seal a chat-mode row that never obtained a workflow. Idempotent: the update
 * is conditional on still being ACTIVE with a null workflow and messageCount 0,
 * so a late Temporal accept or a completed chat turn wins.
 */
async function sealStuckChatAgent(
  candidate: StuckChatCandidate,
  deps: Pick<WorkflowLivenessDependencies, 'finalizeInterruptedTools' | 'releaseBrowserSessions'>,
  membership: string
): Promise<boolean> {
  const inProgressTools = await captureInProgressWorkflowTools(
    candidate.agentId,
    candidate.agentId
  );

  const { count } = await updateAgentUnlessStartPending(
    candidate.agentId,
    undefined,
    undefined,
    {
      where: {
        id: candidate.agentId,
        temporalWorkflowId: null,
        deletedAt: null,
        status: 'ACTIVE',
        messageCount: 0,
      },
      data: { status: 'FAILED', statusMessage: STUCK_CHAT_STATUS_MESSAGE },
    },
    membership
  );

  if (count === 0) return false;

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await deps.finalizeInterruptedTools(candidate.agentId, candidate.agentId, inProgressTools);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  try {
    await deps.releaseBrowserSessions(candidate.agentId);
  } catch (error) {
    if (cleanupFailed) {
      log.warn('Browser cleanup also failed after stuck-chat tool cleanup rejected', {
        agentId: candidate.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (cleanupFailed) {
    const restored = await prisma.agent.updateMany({
      where: {
        id: candidate.agentId,
        temporalWorkflowId: null,
        deletedAt: null,
        status: 'FAILED',
        statusMessage: STUCK_CHAT_STATUS_MESSAGE,
      },
      data: { status: candidate.status, statusMessage: candidate.statusMessage },
    });
    if (restored.count === 0) {
      log.error('Could not restore stuck-chat row after terminal cleanup failed', {
        agentId: candidate.agentId,
      });
    }
    throw cleanupError;
  }
  log.warn('Sealed chat-mode agent whose escalation never started a workflow', {
    agentId: candidate.agentId,
    previousStatus: candidate.status,
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
  const stuckChatCandidates = await findStuckChatCandidates(deps);

  let sealed = 0;
  let inconclusive = 0;

  await mapWithConcurrency(candidates, deps.concurrency, async (candidate) => {
    let temporalStatus: string;
    let membership: string;
    try {
      if (await hasUnacknowledgedWorkflowStart(candidate.agentId, candidate.workflowId)) {
        inconclusive++;
        return;
      }
      membership = await workflowStartMembership(candidate.agentId, candidate.workflowId);
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

    // A reserved replacement is durable intent, not an execution. Temporal
    // cannot find it until start acceptance; the claim owns that interval.
    // Real closed executions still seal, and the terminal CAS also fences the
    // exact chain/claim observed before describe so a concurrent acceptance wins.
    if (
      normalized === 'NOT_FOUND' &&
      candidate.firstExecutionRunId === null &&
      candidate.replacementToken !== null &&
      candidate.workflowId === `${candidate.agentId}:replacement:${candidate.replacementToken}`
    )
      return;

    try {
      if (await sealAgent(candidate, normalized, deps, membership)) sealed++;
    } catch (error) {
      // One provider/tool cleanup failure must not reject the shared worker and
      // abandon every later candidate in its cursor. `sealAgent` has already
      // restored this row so a later quiet-window scan can retry it.
      inconclusive++;
      log.warn('Liveness terminal cleanup inconclusive; restored agent for retry', {
        agentId: candidate.agentId,
        workflowId: candidate.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await mapWithConcurrency(stuckChatCandidates, deps.concurrency, async (candidate) => {
    try {
      if (await hasUnacknowledgedWorkflowStart(candidate.agentId)) {
        inconclusive++;
        return;
      }
      if (
        await sealStuckChatAgent(candidate, deps, await workflowStartMembership(candidate.agentId))
      )
        sealed++;
    } catch (error) {
      inconclusive++;
      log.warn('Stuck-chat terminal cleanup inconclusive; restored agent for retry', {
        agentId: candidate.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const examined = candidates.length + stuckChatCandidates.length;
  if (sealed > 0 || inconclusive > 0) {
    log.info('Workflow liveness reconcile complete', {
      examined,
      sealed,
      inconclusive,
      stuckChatExamined: stuckChatCandidates.length,
    });
  }
  return { examined, sealed, inconclusive };
}
