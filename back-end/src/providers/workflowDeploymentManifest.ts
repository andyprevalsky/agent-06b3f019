import { Prisma, type AgentStatus } from '@prisma/client';
import { prisma } from './database';
import type { WorkflowDeploymentCandidate } from './workflowDeploymentMigration';

const MANIFEST_OPERATION_TYPE = 'TEMPORAL_WORKFLOW_DEPLOYMENT_MANIFEST';
const MANIFEST_KEY_PREFIX = 'deployment:temporal-workflow-manifest:';
const AGENT_STATUSES = new Set<AgentStatus>([
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

export interface WorkflowDeploymentManifest {
  version: 1;
  buildId: string;
  deploymentToken: string;
  snapshotAt: string;
  candidates: Array<{
    agentId: string;
    workflowId: string;
    status?: AgentStatus;
  }>;
}

function manifestKey(buildId: string, deploymentToken: string): string {
  return `${MANIFEST_KEY_PREFIX}${buildId}:${deploymentToken}`;
}

function manifestFromJson(value: Prisma.JsonValue | null): WorkflowDeploymentManifest {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.buildId !== 'string' ||
    typeof value.deploymentToken !== 'string' ||
    typeof value.snapshotAt !== 'string' ||
    !Array.isArray(value.candidates)
  ) {
    throw new Error('Workflow deployment manifest is malformed');
  }
  const candidates = value.candidates.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      typeof candidate.agentId !== 'string' ||
      typeof candidate.workflowId !== 'string'
    ) {
      throw new Error('Workflow deployment manifest contains a malformed candidate');
    }
    const status =
      typeof candidate.status === 'string' && AGENT_STATUSES.has(candidate.status as AgentStatus)
        ? (candidate.status as AgentStatus)
        : undefined;
    if (candidate.status !== undefined && status === undefined) {
      throw new Error('Workflow deployment manifest contains an invalid candidate status');
    }
    return {
      agentId: candidate.agentId,
      workflowId: candidate.workflowId,
      ...(status === undefined ? {} : { status }),
    };
  });
  return {
    version: 1,
    buildId: value.buildId,
    deploymentToken: value.deploymentToken,
    snapshotAt: value.snapshotAt,
    candidates,
  };
}

async function readManifest(
  buildId: string,
  deploymentToken: string
): Promise<WorkflowDeploymentManifest | null> {
  const stored = await prisma.toolSideEffect.findUnique({
    where: { operationKey: manifestKey(buildId, deploymentToken) },
    select: { request: true },
  });
  return stored === null ? null : manifestFromJson(stored.request);
}

/**
 * Persist the exact frozen generations once. A retry for the same deployment
 * token always receives this original set, so migrated canaries are never
 * selected again and agents created after the snapshot never join mid-cutover.
 */
export async function loadOrCreateWorkflowDeploymentManifest(
  buildId: string,
  deploymentToken: string,
  snapshot: () => Promise<{
    snapshotAt: Date;
    candidates: WorkflowDeploymentCandidate[];
  }>
): Promise<{ manifest: WorkflowDeploymentManifest; reused: boolean }> {
  const existing = await readManifest(buildId, deploymentToken);
  if (existing !== null) return { manifest: existing, reused: true };

  const frozen = await snapshot();
  const manifest: WorkflowDeploymentManifest = {
    version: 1,
    buildId,
    deploymentToken,
    snapshotAt: frozen.snapshotAt.toISOString(),
    candidates: frozen.candidates,
  };
  const operationKey = manifestKey(buildId, deploymentToken);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationKey}))`;
    const raced = await tx.toolSideEffect.findUnique({
      where: { operationKey },
      select: { request: true },
    });
    if (raced !== null) {
      return { manifest: manifestFromJson(raced.request), reused: true };
    }
    await tx.toolSideEffect.create({
      data: {
        operationKey,
        operationType: MANIFEST_OPERATION_TYPE,
        status: 'STARTED',
        externalId: `${buildId}:${deploymentToken}`,
        request: manifest as unknown as Prisma.InputJsonObject,
      },
    });
    return { manifest, reused: false };
  });
}

export async function completeWorkflowDeploymentManifest(
  buildId: string,
  deploymentToken: string
): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: manifestKey(buildId, deploymentToken),
      operationType: MANIFEST_OPERATION_TYPE,
    },
    data: {
      status: 'COMPLETED',
      response: { completedAt: new Date().toISOString() },
      error: null,
    },
  });
}
