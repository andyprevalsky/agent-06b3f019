import { Prisma, type AgentStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

/** Per-run artifacts that must not survive a terminal → new-chat-run cutover. */
export const DERIVED_RUN_STATE_RESET = {
  responseSchema: Prisma.DbNull,
  structuredResponse: Prisma.DbNull,
  progress: 0,
  toolsInUse: [] as string[],
  statusMessage: null,
} as const;

/**
 * Follow-up after a finished run: clear derived artifacts and persist the
 * chat-router goal onto Agent.goal so schema / fast-cache / title-fallback
 * key off the new task. First-run escalate must not call this — 2026-07-03
 * forbids overwriting create-time Agent.goal with an LLM paraphrase.
 *
 * The previous goal is not deleted from history (original USER + Cloud Agent
 * `previousGoal` snapshot). This only replaces the live Agent.goal pointer.
 */
export function followUpRunStateUpdate(nextGoal: string, previousGoal: string) {
  const goal = nextGoal.trim();
  const persistGoal = goal.length > 0 && goal !== previousGoal;
  return {
    ...DERIVED_RUN_STATE_RESET,
    ...(persistGoal ? { goal } : {}),
  };
}

export function shouldSnapshotPreviousGoal(nextGoal: string, previousGoal: string): boolean {
  const goal = nextGoal.trim();
  return goal.length > 0 && goal !== previousGoal;
}

/** Update an agent's fields. */
export async function updateAgent(agentId: string, data: Record<string, unknown>) {
  return prisma.agent.update({
    where: { id: agentId },
    data,
  });
}

/** Mark an agent as FAILED only if it's still in a pre-terminal, non-paused state. */
export async function failAgentIfStillActive(
  agentId: string,
  statusMessage: string,
  workflowGeneration?: string
) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: { in: ['STARTING_UP', 'ACTIVE'] },
      ...(workflowGeneration === undefined
        ? {}
        : {
            OR: [{ temporalWorkflowId: null }, { temporalWorkflowId: workflowGeneration }],
          }),
    },
    data: { status: 'FAILED', statusMessage },
  });
}

/** Reactivate a terminal agent only if its observed status and workflow still match. */
export async function clearWorkflowForTerminalAgent(
  agentId: string,
  observedStatus: AgentStatus,
  observedWorkflowId: string,
  _observedFirstExecutionRunId: string | null
) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: observedStatus,
      temporalWorkflowId: observedWorkflowId,
    },
    data: {
      temporalWorkflowId: null,
      temporalFirstExecutionRunId: null,
      status: 'ACTIVE',
      ...DERIVED_RUN_STATE_RESET,
    },
  });
}

export async function softDeleteAgent(agentId: string) {
  return prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });
}

/**
 * Clear `deletedAt` on an archived agent and every archived descendant, undoing
 * what deleteAgentRecursive marked. Bounded by the subtree, so cost tracks the
 * one tree being restored rather than the account's agent count.
 *
 * The run itself is NOT resumed: archiving terminated the Temporal workflow and
 * tore down browser/sandbox sessions, so a restored agent comes back readable
 * and stopped.
 */
export async function restoreAgentAndDescendants(agentId: string) {
  return prisma.$executeRaw`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Agent" WHERE id = ${agentId} AND "deletedAt" IS NOT NULL
      UNION ALL
      SELECT a.id FROM "Agent" a
      JOIN descendants d ON a."parentAgentId" = d.id
      WHERE a."deletedAt" IS NOT NULL
    )
    UPDATE "Agent" SET "deletedAt" = NULL
    WHERE id IN (SELECT id FROM descendants)
  `;
}

/** Look up an archived (soft-deleted) agent, optionally scoped to an owner. */
export async function findArchivedAgent(agentId: string, userId?: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: { not: null },
      ...(userId === undefined ? {} : { userId }),
    },
    select: { id: true, isBenchmark: true },
  });
}

export async function deleteAttentionRequests(agentId: string) {
  return prisma.agentAttentionRequest.deleteMany({
    where: { agentId },
  });
}

export async function createGithubRepoAccess(userId: string, repoUrl: string) {
  return prisma.githubRepoAccess.create({
    data: { userId, repoUrl },
  });
}

export async function deleteAgentTools(agentId: string) {
  return prisma.agentTool.deleteMany({
    where: { agentId },
  });
}

export async function createAgentTools(agentId: string, toolIds: string[]) {
  return prisma.agentTool.createMany({
    data: toolIds.map((toolId) => ({
      agentId,
      toolId,
    })),
  });
}

/** Replace tool assignments atomically. */
export async function replaceAgentTools(agentId: string, toolIds: string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.agentTool.deleteMany({ where: { agentId } });
    await tx.agentTool.createMany({
      data: toolIds.map((toolId) => ({ agentId, toolId })),
    });
  });
}
