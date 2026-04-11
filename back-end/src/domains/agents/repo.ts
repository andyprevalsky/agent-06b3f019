/**
 * Agents domain repo — all Prisma calls for agent CRUD, messages, and related data.
 * Re-exports mutation functions from repoMutations.ts.
 */

// Types used in repoMutations.ts (re-exported below)
import { prisma } from '../../providers/database';

export {
  createAgentTransaction,
  updateAgent,
  softDeleteAgent,
  deleteAttentionRequests,
  createGithubRepoAccess,
  deleteAgentTools,
  createAgentTools,
  replaceAgentTools,
  updateVerifierPrompt,
} from './repoMutations';

// ---------------------------------------------------------------------------
// Agent queries
// ---------------------------------------------------------------------------

/** Fetch top-level agents for a user (no parent, not deleted). */
export async function findTopLevelAgents(userId: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
    },
    select: {
      id: true,
      goal: true,
      model: true,
      reasoningMaxTokens: true,
      source: true,
      progress: true,
      status: true,
      statusMessage: true,
      temporalWorkflowId: true,
      tokenCount: true,
      tokensIn: true,
      tokensOut: true,
      contextSize: true,
      messageCount: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

/** Fetch agents in a sub-agent tree by busId. */
export async function findAgentsByBusId(busId: string) {
  return prisma.agent.findMany({
    where: {
      busId,
      deletedAt: null,
    },
    select: {
      id: true,
      parentAgentId: true,
      goal: true,
      status: true,
      progress: true,
      toolsInUse: true,
      messageCount: true,
      responseSchema: true,
      structuredResponse: true,
      treeCostCents: true,
    },
  });
}

/** Fetch a single agent by ID with optional user ownership check. Includes verifier and tools. */
export async function findAgentWithRelations(agentId: string, userId?: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      ...(userId !== undefined ? { userId } : {}),
      deletedAt: null,
    },
    include: {
      verifier: true,
      tools: {
        include: {
          tool: true,
        },
      },
    },
  });
}

/** Fetch a single agent by ID with optional user ownership check. */
export async function findAgent(agentId: string, userId?: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      ...(userId !== undefined ? { userId } : {}),
      deletedAt: null,
    },
  });
}

/** Fetch a single agent by ID (no ownership check, not deleted). */
export async function findAgentById(agentId: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
  });
}

/** Fetch agent with verifier by ID with optional user ownership check. */
export async function findAgentWithVerifier(agentId: string, userId?: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      ...(userId !== undefined ? { userId } : {}),
      deletedAt: null,
    },
    include: {
      verifier: true,
    },
  });
}

/** Fetch agent status only. */
export async function findAgentStatus(agentId: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    select: {
      id: true,
      status: true,
    },
  });
}

/** Fetch agent by ID (unique). */
export async function findAgentUnique(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
  });
}

/** Fetch parent agent's goal. */
export async function findParentGoal(parentAgentId: string): Promise<string | null> {
  const parent = await prisma.agent.findUnique({
    where: { id: parentAgentId },
    select: { goal: true },
  });
  return parent?.goal ?? null;
}

/** Fetch parent agent status. */
export async function findParentStatus(parentAgentId: string) {
  return prisma.agent.findFirst({
    where: { id: parentAgentId, deletedAt: null },
    select: { status: true },
  });
}

/** Fetch agent with children (for recursive delete). */
export async function findAgentWithChildren(agentId: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    include: {
      children: {
        where: {
          deletedAt: null,
        },
      },
    },
  });
}

/** Fetch ancestor chain for breadcrumb navigation using recursive CTE. */
export async function findAncestors(agentId: string) {
  return prisma.$queryRaw<{ id: string; goal: string }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, goal, "parentAgentId", 0 as depth
      FROM "Agent"
      WHERE id = (SELECT "parentAgentId" FROM "Agent" WHERE id = ${agentId})

      UNION ALL

      SELECT a.id, a.goal, a."parentAgentId", ancestors.depth + 1
      FROM "Agent" a
      JOIN ancestors ON a.id = ancestors."parentAgentId"
    )
    SELECT id, goal FROM ancestors
    ORDER BY depth DESC
  `;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Fetch messages for an agent ordered by timestamp ascending.
 *  If `since` is provided, only returns messages with timestamp > since. */
export async function findMessages(agentId: string, since?: Date) {
  return prisma.message.findMany({
    where: {
      agentId,
      ...(since ? { timestamp: { gt: since } } : {}),
    },
    orderBy: { timestamp: 'asc' },
  });
}

/** Batch fetch messages by IDs, scoped to a user's agents. */
export async function findMessagesByIds(ids: string[], userId: string) {
  return prisma.message.findMany({
    where: {
      id: { in: ids },
      role: { in: ['USER', 'TOOL'] },
      agent: { userId },
    },
    select: {
      id: true,
      text: true,
      role: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool usage
// ---------------------------------------------------------------------------

/** Fetch tool usage summary for an agent. */
export async function findToolUsages(agentId: string) {
  return prisma.toolUsage.findMany({
    where: { agentId },
    select: {
      totalCostCents: true,
      usageItems: true,
    },
  });
}

/** Fetch updated agent with full relations for response. */
export async function findAgentWithFullRelations(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      verifier: true,
      tools: {
        include: {
          tool: true,
        },
      },
    },
  });
}
