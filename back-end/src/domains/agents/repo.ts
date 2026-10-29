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
export { findExploreToolEvidence } from './repoEvidence';
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
      temporalWorkflowId: true,
      progress: true,
      progressEstimate: true,
      progressEstimateGeneration: true,
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

/** One browser task (BrowserSession.id) of this agent, by primary key — status only. */
export async function findAgentBrowserTask(agentId: string, browserTaskId: string) {
  return prisma.browserSession.findFirst({
    where: { id: browserTaskId, agentId },
    select: { status: true },
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
      speed: true,
      worldModelMode: true,
      memoryEnabled: true,
      isBenchmark: true,
      projectId: true,
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

/**
 * Late-commit horizon for in-place user-pause annotations. Their writer sets
 * `recordedAt` inside a transaction that times out after 10s, so a committed
 * annotation is never older than this relative to any cursor it was hidden from.
 */
const USER_PAUSE_REPLAY_WINDOW_MS = 5 * 60_000;

/** User-pause annotations recorded inside the late-commit window before `since`. */
function userPauseReplay(since: Date) {
  const recordedAfter = new Date(since.getTime() - USER_PAUSE_REPLAY_WINDOW_MS).toISOString();
  return {
    role: 'TOOL' as const,
    AND: [
      { metadata: { path: ['userPause', 'reason'], equals: 'user' } },
      { metadata: { path: ['userPause', 'recordedAt'], gt: recordedAfter } },
    ],
  };
}

/** Messages after `since`, ascending, plus recent user-pause annotations; consumers dedupe by ID. */
export async function findMessages(agentId: string, since?: Date, browserToolCallId?: string) {
  return prisma.message.findMany({
    where: {
      agentId,
      ...(since ? { AND: [{ OR: [{ timestamp: { gt: since } }, userPauseReplay(since)] }] } : {}),
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

/** One message row of a live agent by primary key, with optional owner check. */
export async function findAgentMessage(agentId: string, messageId: string, userId?: string) {
  return prisma.message.findFirst({
    where: {
      id: messageId,
      agentId,
      agent: { deletedAt: null, ...(userId !== undefined ? { userId } : {}) },
    },
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

/** Owner of a Rose API key (Index 01 MCP auth), or null for an unknown key. */
export async function findRoseApiKeyOwner(apiKey: string): Promise<string | null> {
  const key = await prisma.roseApiKey.findUnique({ where: { apiKey }, select: { userId: true } });
  return key?.userId ?? null;
}
