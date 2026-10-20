/**
 * Gate-resolution provider.
 *
 * Resolves gates riding on `AgentAttentionRequest.metadata` (marks the request
 * answered, then signals the primary workflow AND every deduped waiter so the
 * whole fanned-in set resumes). Lives in providers/ — not the attention-requests
 * domain — so the integrations OAuth callback and the Stripe webhook can resolve
 * gates without a cross-domain import (mirrors `authAssistanceCompletion`). Uses
 * Prisma + the Temporal client directly.
 */

import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { findDeploymentFencedToolMessage } from './toolLifecycleMessages';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import {
  broadcastAttentionUserMessages,
  persistAttentionUserMessages,
} from './attentionUserMessages';

const log = createLogger('GateResolution');
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface GateWaiter {
  workflowId: string;
  agentId: string;
}

/** The minimal request shape the resolver reads (id + who to signal + waiters). */
export interface ResolvableGateRequest {
  id: string;
  workflowId: string;
  agentId: string;
  metadata: unknown;
}

function readWaiters(metadata: unknown): GateWaiter[] {
  if (metadata === null || typeof metadata !== 'object') return [];
  const raw = (metadata as { gateWaiters?: unknown }).gateWaiters;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is GateWaiter =>
      x !== null &&
      typeof x === 'object' &&
      typeof (x as GateWaiter).workflowId === 'string' &&
      (x as GateWaiter).workflowId.length > 0 &&
      typeof (x as GateWaiter).agentId === 'string' &&
      (x as GateWaiter).agentId.length > 0
  );
}

/** Signal a single workflow's `receive_user_response` inbox (best-effort). */
export async function signalWorkflow(
  workflowId: string,
  agentId: string,
  requestId: string,
  response: string,
  userMessage: string | null = null
): Promise<void> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(
      'receive_user_response',
      JSON.stringify({ request_id: requestId, response, user_message: userMessage })
    );
  } catch (error) {
    log.error('Failed to signal workflow', {
      workflow_id: workflowId,
      agent_id: agentId,
      error: errMsg(error),
    });
  }
}

/** Signal the primary workflow AND every deduped waiter that the gate resolved. */
function workflowTargets(request: ResolvableGateRequest): Map<string, string> {
  const targets = new Map<string, string>();
  targets.set(request.workflowId, request.agentId);
  for (const w of readWaiters(request.metadata)) {
    if (!targets.has(w.workflowId)) targets.set(w.workflowId, w.agentId);
  }
  return targets;
}

/**
 * Requests raised from a code-agent sandbox (`rose approve`, pinned `display`)
 * are awaited by that sandbox's long-poll, not by a workflow. Their agent's
 * workflow is busy running the code-agent tool; a signal would land in its
 * inbox as unrelated user feedback.
 */
function awaitedBySandbox(request: ResolvableGateRequest): boolean {
  const metadata = request.metadata;
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'sandboxTool' in metadata &&
    (metadata as { sandboxTool?: unknown }).sandboxTool !== null &&
    (metadata as { sandboxTool?: unknown }).sandboxTool !== undefined
  );
}

async function signalAllWaiters(
  request: ResolvableGateRequest,
  response: string,
  userMessage: string | null
): Promise<void> {
  if (awaitedBySandbox(request)) return;
  for (const [workflowId, agentId] of workflowTargets(request)) {
    await signalWorkflow(workflowId, agentId, request.id, response, userMessage);
  }
}

export async function finishAttentionMessages(
  tx: Prisma.TransactionClient,
  request: ResolvableGateRequest,
  workflowGenerationAlreadyLocked = false
): Promise<number> {
  const pendingMessages = await tx.message.findMany({
    where: {
      agentId: request.agentId,
      role: 'TOOL',
      AND: [
        { metadata: { path: ['toolStatus'], equals: 'IN_PROGRESS' } },
        {
          OR: [
            {
              metadata: {
                path: ['requestUserApproval', 'attentionRequestId'],
                equals: request.id,
              },
            },
            { metadata: { path: ['attentionRequestId'], equals: request.id } },
          ],
        },
      ],
    },
    orderBy: { id: 'asc' },
    select: { id: true, metadata: true, workflowGeneration: true },
  });

  let finishedCount = 0;
  let workflowGenerationLocked = workflowGenerationAlreadyLocked;
  for (const message of pendingMessages) {
    if (message.metadata === null || Array.isArray(message.metadata)) continue;
    const metadata = message.metadata as Prisma.JsonObject;
    const toolCallId = metadata.toolCallId;
    if (typeof toolCallId === 'string' && toolCallId.length > 0) {
      const workflowGeneration = message.workflowGeneration ?? request.agentId;
      if (!workflowGenerationLocked) {
        await lockAgentWorkflowGeneration(tx, request.agentId);
        workflowGenerationLocked = true;
      }
      // Every lifecycle writer takes the generation lock in shared mode before
      // its tool-call lock. Holding the exclusive generation lock therefore
      // proves that no lifecycle writer can overlap this cleanup; taking the
      // subordinate lock again only adds a transaction-expiring round trip.
      const deploymentFence = await findDeploymentFencedToolMessage(
        tx,
        request.agentId,
        workflowGeneration,
        toolCallId
      );
      if (deploymentFence !== null) continue;
    }
    const updated = await tx.message.updateMany({
      // Compare-and-swap the metadata snapshot returned above. Lifecycle-aware
      // messages are serialized by the advisory locks; legacy messages without
      // a toolCallId still cannot overwrite a concurrent terminal transition.
      where: { id: message.id, metadata: { equals: metadata } },
      data: {
        metadata: {
          ...metadata,
          toolStatus: 'FINISHED',
        },
      },
    });
    finishedCount += updated.count;
  }

  return finishedCount;
}

/**
 * Resolve a gate: mark the response, then signal every waiter. The waiter list is
 * re-read AFTER the update (not from the pre-update snapshot) so a waiter that
 * joined during the resolve is included; once `userResponse` is set, the atomic
 * `appendGateWaiter` can no longer add new waiters (it returns the response and
 * the joiner is signaled directly), so this read captures the final set.
 */
export async function resolveAndSignal(
  request: ResolvableGateRequest,
  response: string,
  userMessage?: string
): Promise<{ resolved: boolean }> {
  // Resolving an approval also serializes against workflow replacement and the
  // tool lifecycle, and it now takes the generation lock FIRST so a response can
  // never hold the attention row while waiting for deployment cleanup's lock.
  // Those row locks can legitimately outlive Prisma's 5s interactive-transaction
  // default under deploy-suite/prod concurrency, and a short timeout rolled back
  // the response and surfaced a false 500 on a healthy database. Keep one atomic
  // transaction, but give the bounded critical section a 30s budget. The
  // transient-start retry wrapper (rather than a bare `prisma.$transaction`) then
  // keeps a contended pool surfacing as a retry rather than a hard gate failure.
  const {
    fresh,
    finishedMessageCount,
    resolved,
    userMessages,
    userMessage: authoredMessage,
    signalResponse,
  } = await runTransactionWithRetry(
    async (tx) => {
      // Deployment cleanup takes this lock before terminalizing attention rows.
      // Keep the same order here so a response can never hold the row while
      // waiting for cleanup's generation lock.
      await lockAgentWorkflowGeneration(tx, request.agentId);
      // Single atomic UPDATE ... RETURNING: the `userResponse IS NULL` predicate
      // is the compare-and-swap, so two concurrent resolvers cannot both win.
      const [current] = await tx.$queryRaw<ResolvableGateRequest[]>`
        UPDATE "AgentAttentionRequest"
        SET "userResponse" = ${response}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${request.id} AND "userResponse" IS NULL
        RETURNING id, "workflowId", "agentId", metadata
      `;
      if (current === undefined) {
        if (!userMessage?.trim()) {
          return {
            fresh: null,
            finishedMessageCount: 0,
            resolved: false,
            userMessages: [],
            userMessage: null,
            signalResponse: response,
          };
        }
        // A late waiter can be registering while this answered-row CAS misses.
        // Read its fan-out only after owning the same attention row lock.
        await tx.$queryRaw`SELECT id FROM "AgentAttentionRequest" WHERE id = ${request.id} FOR UPDATE`;
        const answered = await tx.agentAttentionRequest.findUnique({ where: { id: request.id } });
        if (answered === null)
          return {
            fresh: null,
            finishedMessageCount: 0,
            resolved: false,
            userMessages: [],
            userMessage: null,
            signalResponse: response,
          };
        const authored = await persistAttentionUserMessages(tx, {
          requestId: answered.id,
          agentId: answered.agentId,
          targetAgentIds: workflowTargets(answered).values(),
          userMessage,
        });
        return {
          fresh: answered,
          finishedMessageCount: 0,
          resolved: true,
          ...authored,
          signalResponse: answered.userResponse ?? response,
        };
      }
      const finishedCount = await finishAttentionMessages(tx, current, true);
      const authored = await persistAttentionUserMessages(tx, {
        requestId: current.id,
        agentId: current.agentId,
        targetAgentIds: workflowTargets(current).values(),
        userMessage,
      });
      return {
        fresh: current,
        finishedMessageCount: finishedCount,
        resolved: true,
        ...authored,
        signalResponse: response,
      };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
  log.info('Resolved attention request read model', {
    request_id: request.id,
    agent_id: request.agentId,
    finished_message_count: finishedMessageCount,
    resolved,
  });
  if (!resolved || fresh === null) return { resolved: false };
  broadcastAttentionUserMessages(userMessages);
  await signalAllWaiters(fresh, signalResponse, authoredMessage);
  return { resolved: true };
}

/**
 * Resolver hook for external detections (Stripe webhook, OAuth callback, KYC
 * webhook). Finds the pending gate by dedup key, marks it answered, and signals
 * the primary workflow plus all deduped waiters.
 */
export async function resolvePendingGateByKey(
  userId: string,
  gateKey: string,
  response = 'RESOLVED'
): Promise<{ resolved: boolean; request_id?: string }> {
  const request = await prisma.agentAttentionRequest.findFirst({
    where: { userId, gateKey, userResponse: null },
    orderBy: { createdAt: 'asc' },
  });
  if (request === null) return { resolved: false };

  const result = await resolveAndSignal(request, response);
  return result.resolved ? { resolved: true, request_id: request.id } : { resolved: false };
}
