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

const log = createLogger('AgentKill');

export interface DeleteAgentOptions {
  /** Retry unconfirmed cleanup of an already archived subtree. */
  retryArchived?: boolean;
  /** Temporal terminate reason. Defaults to the UI-archive wording. */
  terminateReason?: string;
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Recursively soft-delete an agent and all its descendants.
 * Cleans up sessions, terminates Temporal workflows, deletes attention requests,
 * then sets `deletedAt`. Idempotent when the agent is already archived.
 */
export async function deleteAgentRecursive(
  agentId: string,
  options: DeleteAgentOptions = {}
): Promise<void> {
  await deleteAgentRecursiveInternal(agentId, options);
}

async function deleteAgentRecursiveInternal(
  agentId: string,
  options: DeleteAgentOptions
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
      if (!(await deleteAgentRecursiveInternal(childId, options))) {
        workflowTerminationHandled = false;
      }
    }

    await cleanupAgentSessions(agentId);

    /* c8 ignore start -- Temporal termination requires live Temporal server */
    if (sealed.temporalWorkflowId !== null && sealed.temporalWorkflowId !== '') {
      try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(sealed.temporalWorkflowId);
        await handle.terminate(terminateReason);
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
          log.warn('Failed to terminate workflow', {
            agent_id: agentId,
            workflow_id: sealed.temporalWorkflowId,
            error: msg,
          });
        }
      }
    } else {
      /* c8 ignore stop */
      log.info('No workflow id for agent, skipping termination', { agent_id: agentId });
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
