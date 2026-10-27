/**
 * Canonical agent kill / archive path.
 *
 * Every soft-delete surface must call `deleteAgentRecursive` here — UI Archive
 * (`DELETE /api/agents/:id`), SMS `kill_agent`, and SMS `/clear`. Do not soft-delete
 * agents, terminate workflows, or wipe attention requests on a parallel path.
 *
 * Diagram:
 *   UI Archive ──┐
 *   SMS kill ────┼──► deleteAgentRecursive ──► sessions + Temporal + attention + deletedAt
 *   SMS /clear ──┘
 *
 * Concurrency fence:
 *   Child create locks parent workflow-generation → checks deletedAt null
 *   Archive locks parent → soft-deletes → snapshots children (same tx)
 *   so a child cannot commit after the snapshot and escape cleanup.
 */

import { prisma, runTransactionWithRetry } from './database';
import { cleanupAgentSessions } from './agentCleanup';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import { archiveEnabled } from './traceArchive';
import {
  enqueueTraceArchiveFinalization,
  heartbeatTraceArchiveDeletion,
  releaseTraceArchiveDeletion,
  runTraceArchiveFinalizationRetries,
  type TraceArchiveDeletionLease,
} from './traceArchiveFinalizationRetry';
import {
  cleanupTerminalAgentWorkflowZombies,
  type WorkflowTerminalCleanupDependencies,
} from './workflowTerminalCleanup';

const log = createLogger('AgentKill');

export interface DeleteAgentOptions {
  /** Retry unconfirmed cleanup of an already archived subtree. */
  retryArchived?: boolean;
  /** Temporal terminate reason. Defaults to the UI-archive wording. */
  terminateReason?: string;
}

/** Temporal seams; production uses the live client. */
export interface AgentKillDependencies {
  terminateWorkflow: (workflowId: string, reason: string) => Promise<void>;
  workflowCleanup: Partial<WorkflowTerminalCleanupDependencies>;
}

/* c8 ignore start -- Temporal termination requires live Temporal server */
async function terminateWorkflowById(workflowId: string, reason: string): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).terminate(reason);
}
/* c8 ignore stop */

const defaultDependencies: AgentKillDependencies = {
  terminateWorkflow: terminateWorkflowById,
  workflowCleanup: {},
};

function errorDetail(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(errorDetail)].join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

interface SealedAgentKill {
  temporalWorkflowId: string | null;
  childIds: string[];
  traceArchiveDeletionLease: TraceArchiveDeletionLease | null;
}

const TRACE_ARCHIVE_DELETION_HEARTBEAT_MS = 30_000;

function startTraceArchiveDeletionHeartbeat(lease: TraceArchiveDeletionLease): () => void {
  const timer = setInterval(() => {
    heartbeatTraceArchiveDeletion(lease).catch((error) => {
      log.warn('Failed to heartbeat trace archive deletion lease', {
        agent_id: lease.rootAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, TRACE_ARCHIVE_DELETION_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function retryRootArchiveFinalization(agentId: string, ignoreGrace: boolean): Promise<void> {
  try {
    await runTraceArchiveFinalizationRetries({
      rootAgentIds: [agentId],
      batchSize: 1,
      maxConcurrency: 1,
      ignoreGrace,
    });
  } catch (error) {
    log.warn('Trace archive finalization retained for retry after agent deletion', {
      agent_id: agentId,
      error: errorDetail(error),
    });
  }
}

/** Status written for an archived agent that had not reached a terminal status. */
export const ARCHIVED_AGENT_STATUS_MESSAGE = 'Archived by user';
const NON_TERMINAL_AGENT_STATUSES = ['STARTING_UP', 'ACTIVE', 'PAUSED'] as const;

/**
 * Recursively soft-delete an agent and all its descendants.
 * Cleans up sessions, terminates Temporal workflows, deletes attention requests,
 * then sets `deletedAt`. A still-running agent also becomes FAILED ("Archived by
 * user") in the same transaction, so archived rows never stay ACTIVE/PAUSED;
 * FAILED is irreversible for later worker status writes. Idempotent when the
 * agent is already archived.
 */
export async function deleteAgentRecursive(
  agentId: string,
  options: DeleteAgentOptions = {},
  dependencyOverrides: Partial<AgentKillDependencies> = {}
): Promise<void> {
  await deleteAgentRecursiveInternal(agentId, options, {
    ...defaultDependencies,
    ...dependencyOverrides,
  });
}

async function deleteAgentRecursiveInternal(
  agentId: string,
  options: DeleteAgentOptions,
  dependencies: AgentKillDependencies
): Promise<boolean> {
  const terminateReason = options.terminateReason ?? 'Agent deleted by user';

  // Soft-delete under the same generation lock child-create uses, then snapshot
  // children in that transaction so no late child can attach after the snapshot.
  const sealed = await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findFirst({
      where: { id: agentId, ...(options.retryArchived === true ? {} : { deletedAt: null }) },
      select: {
        deletedAt: true,
        temporalWorkflowId: true,
        parentAgentId: true,
        children: {
          ...(options.retryArchived === true ? {} : { where: { deletedAt: null } }),
          select: { id: true },
        },
      },
    });
    if (agent === null) {
      return null;
    }
    if (agent.deletedAt === null) {
      await tx.agent.update({
        where: { id: agentId },
        data: { deletedAt: new Date() },
      });
    }
    await tx.agent.updateMany({
      where: { id: agentId, status: { in: [...NON_TERMINAL_AGENT_STATUSES] } },
      data: { status: 'FAILED', statusMessage: ARCHIVED_AGENT_STATUS_MESSAGE },
    });
    const traceArchiveDeletionLease =
      agent.deletedAt === null && agent.parentAgentId === null && archiveEnabled()
        ? await enqueueTraceArchiveFinalization(tx, agentId)
        : null;
    const result: SealedAgentKill = {
      temporalWorkflowId: agent.temporalWorkflowId,
      childIds: agent.children.map((child) => child.id),
      traceArchiveDeletionLease,
    };
    return result;
  });
  if (sealed === null) {
    if (archiveEnabled()) await retryRootArchiveFinalization(agentId, false);
    return true;
  }

  const stopArchiveHeartbeat =
    sealed.traceArchiveDeletionLease === null
      ? null
      : startTraceArchiveDeletionHeartbeat(sealed.traceArchiveDeletionLease);
  let workflowTerminationHandled = true;
  try {
    for (const childId of sealed.childIds) {
      if (!(await deleteAgentRecursiveInternal(childId, options, dependencies))) {
        workflowTerminationHandled = false;
      }
    }

    await cleanupAgentSessions(agentId);

    let ownWorkflowTerminated = true;
    if (sealed.temporalWorkflowId !== null && sealed.temporalWorkflowId !== '') {
      try {
        await dependencies.terminateWorkflow(sealed.temporalWorkflowId, terminateReason);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (
          msg.includes('not found') ||
          msg.includes('already completed') ||
          msg.includes('terminated')
        ) {
          log.info('No active workflow to terminate', {
            agent_id: agentId,
            workflow_id: sealed.temporalWorkflowId,
            reason: msg,
          });
        } else {
          workflowTerminationHandled = false;
          ownWorkflowTerminated = false;
          log.warn('Failed to terminate workflow', {
            agent_id: agentId,
            workflow_id: sealed.temporalWorkflowId,
            error: msg,
          });
        }
      }
    } else {
      log.info('No workflow id for agent, skipping termination', { agent_id: agentId });
    }

    // A terminal transition or this soft-delete enqueued a graced
    // TemporalWorkflowCleanup row, which fences the root's R2 finalization.
    // The workflow is already terminated here, so discharge it now through the
    // canonical exact cleanup instead of leaving it for the later cron.
    if (ownWorkflowTerminated) {
      try {
        await cleanupTerminalAgentWorkflowZombies(dependencies.workflowCleanup, {
          agentIds: [agentId],
          ignoreGrace: true,
          maxConcurrency: 1,
          batchSize: 1,
        });
      } catch (error) {
        log.warn('Temporal workflow cleanup retained after agent deletion', {
          agent_id: agentId,
          error: errorDetail(error),
        });
      }
    }

    await prisma.agentAttentionRequest.deleteMany({ where: { agentId } });
    // DEMO cache entries intentionally outlive agent deletion. They are keyed by
    // goal hash and only removed by the explicit demo-cache purge endpoint.

    if (sealed.traceArchiveDeletionLease !== null && workflowTerminationHandled) {
      try {
        await releaseTraceArchiveDeletion(sealed.traceArchiveDeletionLease);
        await retryRootArchiveFinalization(agentId, true);
      } catch (error) {
        log.warn('Trace archive deletion lease retained for retry', {
          agent_id: agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (sealed.traceArchiveDeletionLease !== null) {
      log.warn('Trace archive deletion lease retained after workflow termination failure', {
        agent_id: agentId,
      });
    }

    log.info('Deleted agent', { agent_id: agentId, terminate_reason: terminateReason });
    return workflowTerminationHandled;
  } finally {
    stopArchiveHeartbeat?.();
  }
}
