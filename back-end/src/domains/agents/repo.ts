/**
 * Agents domain repo — all Prisma calls for agent CRUD, messages, and related data.
 * Re-exports mutation functions from repoMutations.ts.
 */

// Types used in repoMutations.ts (re-exported below)
import { prisma } from '../../providers/database';

export {
  createAgentTransaction,
  createAgentBatchTransaction,
  updateAgent,
  failAgentIfStillActive,
  clearWorkflowForTerminalAgent,
  DERIVED_RUN_STATE_RESET,
  followUpRunStateUpdate,
  shouldSnapshotPreviousGoal,
  softDeleteAgent,
  restoreAgentAndDescendants,
  findArchivedAgent,
  deleteAttentionRequests,
  createGithubRepoAccess,
  deleteAgentTools,
  createAgentTools,
  replaceAgentTools,
} from './repoMutations';
export type { BatchCreateAgentParams } from './repoMutations';
export { findExistingAgentsByIds } from './repoDescendantStarts';
export {
  findTopLevelAgents,
  findTopLevelAgentsMatching,
  findArchivedTopLevelAgents,
} from './repoSidebarLists';
export {
  pauseAgentUnderWorkflowLock,
  updateAgentConfigMutation,
  updateAgentForWorkflow,
  updateAgentUnderWorkflowLock,
} from './repoWorkflowMutations';

// ---------------------------------------------------------------------------
// Agent queries
// ---------------------------------------------------------------------------

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
      tokensIn: true,
      tokensOut: true,
      responseSchema: true,
      structuredResponse: true,
      treeCostCents: true,
      taskPath: true,
      createdAt: true,
      updatedAt: true,
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

/** Resolve the minimal owner context needed by the external failure-alert workflow. */
export async function findAgentAlertContext(agentId: string) {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
    },
    select: {
      id: true,
      userId: true,
      status: true,
    },
  });
  if (!agent) return null;

  const user = await prisma.user.findUnique({
    where: { userId: agent.userId },
    select: { name: true },
  });
  return { ...agent, userName: user?.name ?? null };
}

/** Resolve the account identity displayed while an administrator inspects a run. */
export async function findUserInspectionIdentity(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: { name: true, phone: true, email: true },
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

/** Fetch an agent's proxy geo fields. Used by sub-agent creation to inherit
 *  the parent's proxyCountry/State/City instead of geolocating the worker IP. */
export async function findAgentProxy(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      proxyCountry: true,
      proxyState: true,
      proxyCity: true,
    },
  });
}

/** Look up a user's delivery address (city/state/country). Used as the proxy
 *  geolocation fallback for server-originated agents (no client IP), e.g. SMS
 *  or scheduled runs — see resolveCreateMetadata. Returns null if the user has
 *  no address on file. */
export async function findUserDeliveryAddress(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      city: true,
      state: true,
      country: true,
    },
  });
}

/** Fetch parent execution-mode flags in bulk for batch-created sub-agents. */
export async function findExecutionModeFlagsByIds(agentIds: string[], userId?: string) {
  if (agentIds.length === 0) return [];
  return prisma.agent.findMany({
    where: {
      id: { in: agentIds },
      deletedAt: null,
      ...(userId !== undefined ? { userId } : {}),
    },
    select: {
      id: true,
      fastModeCacheEnabled: true,
      worldModelMode: true,
      memoryEnabled: true,
      isBenchmark: true,
    },
  });
}

/** Fetch parent agent status. */
export async function findParentStatus(parentAgentId: string) {
  return prisma.agent.findFirst({
    where: { id: parentAgentId, deletedAt: null },
    select: { status: true },
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
export async function findMessages(agentId: string, since?: Date, browserToolCallId?: string) {
  return prisma.message.findMany({
    where: {
      agentId,
      ...(since ? { timestamp: { gt: since } } : {}),
      ...(browserToolCallId === undefined
        ? {}
        : {
            OR: [
              { role: 'USER' as const },
              {
                role: 'TOOL' as const,
                AND: [
                  { metadata: { path: ['toolCallId'], equals: browserToolCallId } },
                  { metadata: { path: ['toolName'], equals: 'spawn_browser_agent' } },
                  { metadata: { path: ['action_type'], equals: 'session_starting' } },
                ],
              },
            ],
          }),
    },
    orderBy: { timestamp: 'asc' },
  });
}

/** Bounded recovery read for one explore task after its activity is cancelled. */
export async function findExploreToolEvidence(agentId: string, userId: string, taskId: string) {
  const where = {
    agentId,
    agent: { userId },
    role: 'TOOL' as const,
    AND: [
      { metadata: { path: ['taskId'], equals: taskId } },
      { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
    ],
    NOT: { metadata: { path: ['toolName'], equals: 'spawn_agent' } },
  };
  const select = { id: true, text: true, metadata: true } as const;
  const [first, last] = await Promise.all([
    prisma.message.findMany({ where, orderBy: { timestamp: 'asc' }, take: 8, select }),
    prisma.message.findMany({ where, orderBy: { timestamp: 'desc' }, take: 8, select }),
  ]);
  // Read at most 16 rows so failed fetches can be removed before selecting
  // early and late successful evidence.
  return [...new Map([...first, ...last.reverse()].map((row) => [row.id, row])).values()];
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

/**
 * The generation an unattributed internal write should join.
 *
 * Returns the agent's live `temporalWorkflowId`, or null when it owns no
 * workflow yet. Callers must NOT substitute the agent id on a miss: the agent
 * id is generation 1's workflow id, so fabricating it makes an unattributed
 * write look like a stale first-generation worker.
 */
export async function currentAgentWorkflowGeneration(agentId: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });
  return agent?.temporalWorkflowId ?? null;
}
