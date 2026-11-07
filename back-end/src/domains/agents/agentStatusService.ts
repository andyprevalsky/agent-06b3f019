import {
  releaseAgentBrowserSessions,
  releaseAgentCodeSessions,
} from '../../providers/agentCleanup';
import { broadcastAgentUpdate } from '../../providers/chat';
import { classifyAgentFailureForSurface } from '../../providers/credentialPropagation';
import { createLogger } from '../../providers/logger';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { finalizeAgent } from '../../providers/traceArchiveLifecycle';
import { TERMINAL_STATUSES, workflowIdForStatusBroadcast } from './statusBroadcastWorkflowId';
import type { Prisma, UpdateStatusBody } from './types';
import * as repo from './repo';

const log = createLogger('Agents');
const IRREVERSIBLE_STATUSES = new Set(['COMPLETED', 'FAILED']);
const NON_TERMINAL_STATUSES = new Set(['STARTING_UP', 'ACTIVE', 'PAUSED']);

interface UpdateAgentStatusDependencies {
  cleanupPurchaseCards?: (agentId: string) => Promise<void>;
  releaseBrowserSessions?: typeof releaseAgentBrowserSessions;
  releaseCodeSessions?: typeof releaseAgentCodeSessions;
}

async function releaseTerminalBrowserSessions(
  agentId: string,
  status: string,
  isRoot: boolean,
  dependencies: UpdateAgentStatusDependencies
): Promise<void> {
  // Every terminal agent, including children, owns its own browser rentals.
  // A child pauses them; the root's completion saves signed-in state and then
  // tears its sessions down (closeSession persists before the provider close).
  // Purchase settlement and trace finalization remain root-only below.
  try {
    await (dependencies.releaseBrowserSessions ?? releaseAgentBrowserSessions)(
      agentId,
      {},
      { retire: isRoot }
    );
  } catch (error) {
    log.warn('Terminal browser-session release unavailable', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function releaseTerminalCodeSessions(
  agentId: string,
  status: string,
  dependencies: UpdateAgentStatusDependencies
): Promise<void> {
  // A finished agent's code tasks stay ACTIVE otherwise, and their sandbox runs
  // until E2B's idle timeout pauses it forever. Persistent sessions are
  // checkpointed and paused (resumable); one-shot sandboxes are killed. A failed
  // release leaves the task ACTIVE for the reconciler (agentCleanup.ts).
  try {
    await (dependencies.releaseCodeSessions ?? releaseAgentCodeSessions)(agentId);
  } catch (error) {
    log.warn('Terminal code-session release unavailable; reconciler will retry', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runRootTerminalCleanup(
  agentId: string,
  status: string,
  dependencies: UpdateAgentStatusDependencies
): Promise<void> {
  try {
    await (dependencies.cleanupPurchaseCards ?? cleanupAgentPurchaseCards)(agentId);
  } catch (error) {
    log.warn('Terminal purchase-card cleanup unavailable; cron will retry', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await finalizeAgent({ rootAgentId: agentId });
  } catch (error) {
    log.warn('Trace archive finalization unavailable', {
      agent_id: agentId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Slack auto-RCA agents post their result to the incident thread. One indexed
 * lookup per terminal root; every other agent exits there. Fire-and-forget so
 * a Slack outage never delays the status write. Dynamic import keeps the
 * agents and slack-auto-rca domains decoupled for layer-deps.
 */
function reportAutoRcaOutcome(agentId: string): void {
  void import('../slack-auto-rca/outcomeService')
    .then(({ reportSlackAutoRcaOutcome }) => reportSlackAutoRcaOutcome(agentId))
    .catch((error: unknown) => {
      log.warn('Slack auto-RCA outcome import failed', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function statusUpdate(body: UpdateStatusBody): Prisma.AgentUpdateManyMutationInput {
  return {
    status: body.status,
    statusMessage: body.statusMessage,
    progress: body.progress,
    tokenCount: body.tokenCount,
    tokensIn: body.tokensIn,
    tokensOut: body.tokensOut,
    contextSize: body.contextSize,
    messageCount: body.messageCount,
    ...(body.iterationOffset !== undefined && {
      workflowIterationOffset: body.iterationOffset,
    }),
    ...(body.structuredResponse !== undefined && {
      structuredResponse: body.structuredResponse as Prisma.InputJsonValue,
    }),
    updatedAt: new Date(),
  };
}

async function persistStatus(agentId: string, body: UpdateStatusBody, workflowGeneration?: string) {
  const update = statusUpdate(body);
  return repo.updateAgentForWorkflow(agentId, workflowGeneration, update);
}

async function failureSurface(agentId: string, body: UpdateStatusBody) {
  if (!TERMINAL_STATUSES.has(body.status) || body.status === 'COMPLETED') return {};
  const fallback = { rawError: body.statusMessage ?? body.status, failureReason: null };
  try {
    const decision = await classifyAgentFailureForSurface(agentId);
    return {
      rawError: decision?.rawError ?? fallback.rawError,
      failureReason: decision?.failureReason ?? null,
    };
  } catch (error) {
    log.warn('Failure classification unavailable for terminal status broadcast', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

async function broadcastStatus(
  agentId: string,
  body: UpdateStatusBody,
  temporalWorkflowId: string | null,
  userControlRevision: number
): Promise<void> {
  await broadcastAgentUpdate(agentId, {
    progress: body.progress,
    status: body.status,
    userControlRevision,
    statusMessage: body.statusMessage ?? undefined,
    tokenCount: body.tokenCount,
    tokensIn: body.tokensIn,
    tokensOut: body.tokensOut,
    contextSize: body.contextSize,
    messageCount: body.messageCount,
    temporalWorkflowId: workflowIdForStatusBroadcast(body.status, temporalWorkflowId),
    ...(await failureSurface(agentId, body)),
  });
}

/** Persist worker status only if its producing workflow generation is still current. */
export async function updateAgentStatus(
  agentId: string,
  body: UpdateStatusBody,
  dependencies: UpdateAgentStatusDependencies = {},
  workflowGeneration?: string
) {
  const before = await repo.findAgentById(agentId);
  if (before === null) return null;
  if (
    workflowGeneration !== undefined &&
    before.temporalWorkflowId !== null &&
    before.temporalWorkflowId !== workflowGeneration
  ) {
    return before;
  }
  if (IRREVERSIBLE_STATUSES.has(before.status) && NON_TERMINAL_STATUSES.has(body.status)) {
    return before;
  }

  const result = await persistStatus(agentId, body, workflowGeneration);
  if (result.agent === null || !result.accepted) return result.agent;
  await broadcastStatus(
    agentId,
    { ...body, status: result.agent.status },
    result.agent.temporalWorkflowId,
    result.agent.userControlRevision
  );
  // Platform GMV: any agent (root or child) that completes with a structured
  // output containing BOTH a USD amount and an order/confirmation id.
  // Dynamic import keeps agents/purchases domains decoupled for layer-deps.
  if (body.status === 'COMPLETED' && body.structuredResponse !== undefined) {
    void import('../purchases/structuredGmv')
      .then(({ maybeRecordStructuredGmv }) =>
        maybeRecordStructuredGmv({
          userId: before.userId,
          agentId,
          structured: body.structuredResponse,
          source: 'agent.structuredResponse',
        })
      )
      .catch((error: unknown) => {
        log.warn('Structured GMV dynamic import/record failed', {
          agent_id: agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  const firstTerminal = TERMINAL_STATUSES.has(body.status) && !TERMINAL_STATUSES.has(before.status);
  if (firstTerminal) {
    const isRoot = before.parentAgentId === null;
    await releaseTerminalBrowserSessions(agentId, body.status, isRoot, dependencies);
    if (isRoot) {
      await runRootTerminalCleanup(agentId, body.status, dependencies);
      reportAutoRcaOutcome(agentId);
    }
    // Last: persistent-session close connects to the sandbox, checkpoints and
    // pauses with no timeout. The status row is already terminal, so a retried
    // PATCH is not `firstTerminal` and would never rerun the root-only steps
    // above; the reconciler does retry a failed or interrupted code release.
    await releaseTerminalCodeSessions(agentId, body.status, dependencies);
  }
  return result.agent;
}
