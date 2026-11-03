import { Prisma, type Message } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  incomingWorkflowGeneration,
  lockAgentWorkflowGenerationShared,
  messageWorkflowGeneration,
} from './workflowGeneration';
import type { CreateMessageParams } from './messages';

const TOOL_LIFECYCLE_LOCK_SEED = 7_104_291;
const TERMINAL_TOOL_STATUSES = new Set(['FINISHED', 'ERROR', 'SUCCESS', 'FAILED', 'COMPLETED']);

export function stringMetadataValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function messageMetadata(message: Message): Record<string, unknown> | null {
  const metadata = message.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

export function isTerminalToolStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_TOOL_STATUSES.has(status.toUpperCase());
}

function isInProgressToolStatus(status: unknown): boolean {
  return typeof status === 'string' && status.toUpperCase() === 'IN_PROGRESS';
}

export function toolLifecycleIdentity(
  params: CreateMessageParams
): { toolCallId: string; toolStatus: string; workflowGeneration: string } | null {
  if (params.role !== 'TOOL') return null;
  const toolCallId = stringMetadataValue(params.metadata, 'toolCallId');
  const toolStatus = stringMetadataValue(params.metadata, 'toolStatus');
  if (
    toolCallId === null ||
    toolStatus === null ||
    (!isInProgressToolStatus(toolStatus) && !isTerminalToolStatus(toolStatus))
  ) {
    return null;
  }
  return {
    toolCallId,
    toolStatus,
    workflowGeneration: incomingWorkflowGeneration(params.agentId, params.metadata),
  };
}

function normalizeJsonForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonForCompare);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entryValue]) => [key, normalizeJsonForCompare(entryValue)])
    );
  }
  return value;
}

export function metadataEquals(
  incoming: Record<string, unknown> | null | undefined,
  existing: Prisma.JsonValue | null | undefined
): boolean {
  return (
    JSON.stringify(normalizeJsonForCompare(incoming ?? null)) ===
    JSON.stringify(normalizeJsonForCompare(existing ?? null))
  );
}

/** Serialize lifecycle transitions for one tool call across backend instances. */
export async function lockToolCallLifecycle(
  tx: Prisma.TransactionClient,
  agentId: string,
  workflowGeneration: string,
  toolCallId: string
): Promise<void> {
  const lockKey = `${agentId}:${workflowGeneration}:${toolCallId}`;
  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, ${TOOL_LIFECYCLE_LOCK_SEED}))
    )
    SELECT 1 AS locked FROM acquired
  `;
}

function isDeploymentFencedMessage(message: Message): boolean {
  const metadata = messageMetadata(message);
  return metadata?.deploymentFenced === true || metadata?.errorCode === 'DEPLOY_INTERRUPTED';
}

export async function findDeploymentFencedToolMessage(
  tx: Prisma.TransactionClient,
  agentId: string,
  workflowGeneration: string,
  toolCallId: string
): Promise<Message | null> {
  const messages = await tx.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
    orderBy: { timestamp: 'desc' },
  });
  return (
    messages.find(
      (message) =>
        messageWorkflowGeneration(message) === workflowGeneration &&
        isDeploymentFencedMessage(message)
    ) ?? null
  );
}

function matchingToolMessage(candidates: Message[], params: CreateMessageParams): Message | null {
  const title = stringMetadataValue(params.metadata, 'title');
  return (
    candidates.find((candidate) => {
      const metadata = messageMetadata(candidate);
      return (
        candidate.text === params.text &&
        candidate.filePointer === null &&
        (title === null || metadata?.title === title) &&
        metadataEquals(params.metadata, candidate.metadata)
      );
    }) ?? null
  );
}

function withoutDeploymentFenceMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null | undefined {
  if (metadata === null || metadata === undefined) return metadata;
  const safe = { ...metadata };
  delete safe.deploymentFenced;
  if (safe.errorCode === 'DEPLOY_INTERRUPTED') delete safe.errorCode;
  return safe;
}

function deploymentInterruptedParams(
  params: CreateMessageParams,
  identity: { toolCallId: string; workflowGeneration: string }
): CreateMessageParams {
  return {
    ...params,
    text: DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    metadata: {
      ...params.metadata,
      workflowGeneration: identity.workflowGeneration,
      toolCallId: identity.toolCallId,
      toolStatus: 'FINISHED',
      title: 'Tool interrupted by deployment',
      error: true,
      errorCode: 'DEPLOY_INTERRUPTED',
      deploymentFenced: true,
    },
  };
}

async function currentWorkflowId(
  tx: Prisma.TransactionClient,
  params: CreateMessageParams
): Promise<string | null | undefined> {
  if (params.enforceCurrentWorkflowGeneration !== true) return undefined;
  const agent = await tx.agent.findUnique({
    where: { id: params.agentId },
    select: { temporalWorkflowId: true },
  });
  return agent?.temporalWorkflowId;
}

async function fenceLatestTerminal(
  tx: Prisma.TransactionClient,
  candidates: Message[]
): Promise<Message | null> {
  const latestCandidate = candidates
    .slice()
    .reverse()
    .find((candidate) => {
      const status = messageMetadata(candidate)?.toolStatus;
      return isInProgressToolStatus(status) || isTerminalToolStatus(status);
    });
  if (
    latestCandidate === undefined ||
    !isTerminalToolStatus(messageMetadata(latestCandidate)?.toolStatus)
  ) {
    return null;
  }
  const metadata = messageMetadata(latestCandidate) ?? {};
  return tx.message.update({
    where: { id: latestCandidate.id },
    data: { metadata: { ...metadata, deploymentFenced: true } as Prisma.InputJsonValue },
  });
}

/**
 * A background spawn's tool call keeps ONE model-visible result: its
 * `runInBackground` "started" row. Every later row under the same toolCallId
 * (the executor's progress / result rows, written by the workflow or by an
 * activity, and deployment finalizers) is UI-only, so it is stamped
 * `excludeFromModel` here, under the call's lifecycle lock (the started row is
 * always committed before the executor starts). See
 * agents/workflows/background_agents.py.
 */
function withBackgroundExecutionStamp(
  params: CreateMessageParams,
  candidates: Message[]
): CreateMessageParams {
  const metadata = params.metadata;
  if (metadata?.runInBackground === true) return params;
  const backgroundSpawn = candidates.some(
    (candidate) => messageMetadata(candidate)?.runInBackground === true
  );
  if (!backgroundSpawn) return params;
  // A woken task's later run: its workflow rows carry `backgroundRun`; rows its
  // activity writes under the same id join that run (FE chip/dock per run).
  const run =
    typeof metadata?.backgroundRun === 'number' ? undefined : latestBackgroundRun(candidates);
  if (metadata?.excludeFromModel === true && run === undefined) return params;
  return {
    ...params,
    metadata: {
      ...metadata,
      excludeFromModel: true,
      ...(run !== undefined ? { backgroundRun: run } : {}),
    },
  };
}

function latestBackgroundRun(candidates: Message[]): number | undefined {
  let run: number | undefined;
  for (const candidate of candidates) {
    const value = messageMetadata(candidate)?.backgroundRun;
    if (typeof value === 'number' && value > 1 && (run === undefined || value > run)) run = value;
  }
  return run;
}

export async function persistLockedToolLifecycleMessage(
  tx: Prisma.TransactionClient,
  incomingParams: CreateMessageParams,
  identity: { toolCallId: string; workflowGeneration: string }
): Promise<{ message: Message; created: boolean; accepted: boolean; updated?: boolean }> {
  await lockAgentWorkflowGenerationShared(tx, incomingParams.agentId);
  await lockToolCallLifecycle(
    tx,
    incomingParams.agentId,
    identity.workflowGeneration,
    identity.toolCallId
  );
  const allCandidates = await tx.message.findMany({
    where: {
      agentId: incomingParams.agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: identity.toolCallId },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const params = withBackgroundExecutionStamp(incomingParams, allCandidates);
  const candidates = allCandidates.filter(
    (candidate) => messageWorkflowGeneration(candidate) === identity.workflowGeneration
  );
  const deploymentFence = candidates.find(isDeploymentFencedMessage) ?? null;
  if (deploymentFence !== null) {
    return { message: deploymentFence, created: false, accepted: false };
  }

  const workflowId = await currentWorkflowId(tx, params);
  const staleWorkerWrite =
    workflowId !== undefined &&
    workflowId !== identity.workflowGeneration &&
    !(workflowId === null && identity.workflowGeneration === params.agentId);
  const effectiveParams = staleWorkerWrite
    ? deploymentInterruptedParams(params, identity)
    : params.enforceCurrentWorkflowGeneration === true && params.allowDeploymentFinalizer !== true
      ? { ...params, metadata: withoutDeploymentFenceMetadata(params.metadata) }
      : params;
  if (staleWorkerWrite || params.allowDeploymentFinalizer === true) {
    const latestTerminal = await fenceLatestTerminal(tx, candidates);
    if (latestTerminal !== null) {
      return { message: latestTerminal, created: false, accepted: !staleWorkerWrite };
    }
  }
  // Only the workflow which observed the user's pause may annotate the result.
  // Reuse the lifecycle lock: cancellation and a final activity write can race.
  const parentTerminalWrite =
    !params.metadata?.subAgentId &&
    params.metadata?.excludeFromModel !== true &&
    isTerminalToolStatus(params.metadata?.toolStatus);
  const pausedResult = candidates.find((candidate) => {
    const pause = messageMetadata(candidate)?.userPause as Record<string, unknown> | undefined;
    return pause?.reason === 'user' && typeof pause.recordedAt === 'string';
  });
  if (pausedResult !== undefined && parentTerminalWrite) {
    return { message: pausedResult, created: false, accepted: !staleWorkerWrite };
  }
  if (
    !staleWorkerWrite &&
    parentTerminalWrite &&
    params.enforceCurrentWorkflowGeneration === true &&
    params.metadata?.toolName === 'spawn_browser_agent' &&
    params.metadata?.userPauseRequested === true
  ) {
    const visibleCandidates = candidates
      .slice()
      .reverse()
      .filter((candidate) => {
        const meta = messageMetadata(candidate);
        return !meta?.subAgentId && meta?.excludeFromModel !== true;
      });
    const previous =
      visibleCandidates.find((candidate) =>
        isTerminalToolStatus(messageMetadata(candidate)?.toolStatus)
      ) ??
      visibleCandidates.find((candidate) =>
        isInProgressToolStatus(messageMetadata(candidate)?.toolStatus)
      );
    const metadata = { ...(previous ? messageMetadata(previous) : params.metadata) };
    delete metadata.userPauseRequested;
    const recordedAt = new Date().toISOString();
    metadata.userPause = { reason: 'user', recordedAt };
    if (!previous || !isTerminalToolStatus(metadata.toolStatus)) {
      metadata.toolStatus = 'FINISHED';
      metadata.action_type = 'task_complete';
    }
    if (params.metadata.browser_cleanup !== undefined) {
      metadata.userPause = {
        ...(metadata.userPause as object),
        browserCleanup: params.metadata.browser_cleanup,
      };
      // Preserve an earlier cleanup failure as well as the pause observation.
      if (metadata.browser_cleanup === undefined)
        metadata.browser_cleanup = params.metadata.browser_cleanup;
    }
    const originalText = previous?.text ?? '';
    const text = originalText
      ? `${originalText}\n\n[User paused the browser agent.]`
      : 'User paused the browser agent.';
    if (previous) {
      const message = await tx.message.update({
        where: { id: previous.id },
        data: { text, metadata: metadata as Prisma.InputJsonValue },
      });
      return { message, created: false, updated: true, accepted: true };
    }
    const message = await tx.message.create({
      data: {
        agentId: params.agentId,
        workflowGeneration: identity.workflowGeneration,
        role: 'TOOL',
        text,
        metadata: metadata as Prisma.InputJsonValue,
        timestamp: new Date(recordedAt),
      },
    });
    return { message, created: true, accepted: true };
  }
  if (effectiveParams.skipDuplicateToolCheck !== true) {
    const duplicate = matchingToolMessage(candidates, effectiveParams);
    if (duplicate !== null) {
      return { message: duplicate, created: false, accepted: !staleWorkerWrite };
    }
  }
  const message = await tx.message.create({
    data: {
      agentId: params.agentId,
      workflowGeneration: identity.workflowGeneration,
      text: effectiveParams.text,
      role: effectiveParams.role,
      metadata: (effectiveParams.metadata as Prisma.InputJsonValue) ?? undefined,
      filePointer: effectiveParams.filePointer ?? undefined,
      timestamp: new Date(),
    },
  });
  return { message, created: true, accepted: !staleWorkerWrite };
}

export async function persistToolLifecycleMessage(
  params: CreateMessageParams,
  identity: { toolCallId: string; workflowGeneration: string }
): Promise<{ message: Message; created: boolean; accepted: boolean; updated?: boolean }> {
  return runTransactionWithRetry((tx) => persistLockedToolLifecycleMessage(tx, params, identity));
}
