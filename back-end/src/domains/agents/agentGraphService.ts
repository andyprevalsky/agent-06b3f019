/**
 * Agent graph (callers, scope, list, grep, token refresh): code agents (Claude Code / Codex sessions) and Rose agents of
 * ONE tree can list each other, message each other and grep the tree.
 *
 *   caller (token: code session | API key + X-Agent-Id [+ X-Code-Session-Id])
 *     ├─ list  → tree agents (BFS from root) + their code sessions
 *     ├─ send  → (agentGraphSendService) Rose agent: idempotent USER message (normal postMessage path)
 *     │          code agent: deliverUserTurnToCodeSession (sender "agent") →
 *     │                      the CLI's next user turn, delivered once per id
 *     │          + child-scoped chip rows so the code agent's own timeline
 *     │            shows "<sender> → Codex" / "Codex → <target>"
 *     ├─ route → (agentGraphQuestionService) read-only question-route decision;
 *     │          code agents cannot ask (there is no ask route)
 *     └─ grep  → agent_trajectories, path pinned to agent_trajectories/<root>
 *
 * Scope: every target is resolved by walking ITS parent links to a root and
 * comparing with the caller's root + user. Anything outside → 404 (no
 * existence oracle across users or trees). 10k agents: one tree walk per
 * request (O(depth) indexed lookups), one short ws per code-agent message,
 * no fan-out and no shared channel.
 */
import { mintAgentGraphToken, type AgentGraphClaims } from '../../providers/agentGraph/token';
import { executeUserDataGrep, type UserDataGrepResult } from '../../providers/userDataSearch';
import * as graphRepo from './repoGraph';

export type CodeProvider = 'claude' | 'codex';

export type GraphSelf =
  | { kind: 'code'; id: string; ownerAgentId: string; provider: CodeProvider }
  | { kind: 'agent'; id: string };

export interface GraphCaller {
  userId: string;
  rootAgentId: string;
  self: GraphSelf;
}

export class AgentGraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set on 429: when the sender may try again (the Retry-After header). */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

export const NOT_FOUND = 'Agent not found in this tree';

/** Resolve an internal (API key) caller from the Rose agent it acts for. */
export async function callerForAgent(agentId: string): Promise<GraphCaller> {
  const agent = await graphRepo.findGraphAgent(agentId);
  if (agent === null) throw new AgentGraphError(404, 'Agent not found');
  const rootAgentId = await graphRepo.findGraphRootId(agent.id, agent.userId);
  if (rootAgentId === null) throw new AgentGraphError(404, 'Agent not found');
  return { userId: agent.userId, rootAgentId, self: { kind: 'agent', id: agent.id } };
}

/**
 * Internal (API key) caller acting AS one code session, e.g. the agents
 * worker relaying a question a code agent emitted. The session must belong to
 * `agentId`, the worker's own Rose agent.
 */
export async function callerForCodeSession(
  agentId: string,
  sessionId: string,
  provider: CodeProvider
): Promise<GraphCaller> {
  const owner = await callerForAgent(agentId);
  const session = await graphRepo.findGraphCodeSession(sessionId);
  if (session === null || session.agentId !== agentId) {
    throw new AgentGraphError(404, 'Code session not found');
  }
  return {
    ...owner,
    self: { kind: 'code', id: session.id, ownerAgentId: agentId, provider },
  };
}

/**
 * A code-session token is valid only while its task is open and its claims
 * still describe the session's real owner, user and tree. A resumed session
 * runs as a new task with a freshly minted token, so an ended task's token
 * (e.g. a refreshed copy left on disk) cannot act for it.
 */
export async function assertCodeCallerLive(caller: GraphCaller): Promise<void> {
  if (caller.self.kind !== 'code') return;
  const session = await graphRepo.findGraphCodeSession(caller.self.id);
  if (session === null || session.agentId !== caller.self.ownerAgentId) {
    throw new AgentGraphError(401, 'Code session is not registered');
  }
  if (session.status === 'CLOSED') {
    throw new AgentGraphError(401, 'This code session task has ended; use the current token');
  }
  const root = await graphRepo.findGraphRootId(caller.self.ownerAgentId, caller.userId);
  if (root !== caller.rootAgentId) {
    throw new AgentGraphError(401, 'Token does not match the code session’s agent tree');
  }
}

export async function inCallerTree(caller: GraphCaller, agentId: string): Promise<boolean> {
  const root = await graphRepo.findGraphRootId(agentId, caller.userId);
  return root === caller.rootAgentId;
}

/** `root` / `parent` aliases, so an agent can escalate without knowing ids. */
export async function resolveAlias(caller: GraphCaller, to: string): Promise<string> {
  if (to === 'root') return caller.rootAgentId;
  if (to !== 'parent') return to;
  if (caller.self.kind === 'code') return caller.self.ownerAgentId;
  const self = await graphRepo.findGraphAgent(caller.self.id);
  if (self === null || self.parentAgentId === null) {
    throw new AgentGraphError(400, 'The root agent has no parent; ask the user instead');
  }
  return self.parentAgentId;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: 'agent' | 'code';
  provider?: CodeProvider;
  parent_id: string | null;
  depth: number;
  status: string;
  title: string | null;
  goal: string;
  relation: 'self' | 'root' | 'parent' | 'sibling' | 'child' | 'other';
  created_at: string;
}

const GOAL_PREVIEW_CHARS = 300;

function relationOf(
  self: GraphSelf,
  selfParentId: string | null,
  node: { id: string; parentId: string | null },
  rootAgentId: string
): GraphNode['relation'] {
  if (node.id === self.id) return 'self';
  if (node.id === rootAgentId) return 'root';
  if (selfParentId !== null && node.id === selfParentId) return 'parent';
  if (node.parentId !== null && node.parentId === self.id) return 'child';
  if (selfParentId !== null && node.parentId === selfParentId) return 'sibling';
  return 'other';
}

export async function listGraph(caller: GraphCaller): Promise<{
  root_agent_id: string;
  self_id: string;
  truncated: boolean;
  agents: GraphNode[];
}> {
  const agents = await graphRepo.listGraphTreeAgents(caller.rootAgentId, caller.userId);
  const sessions = await graphRepo.listGraphCodeSessions(agents.map((agent) => agent.id));
  const sessionsByOwner = new Map<string, graphRepo.GraphCodeSessionRow[]>();
  for (const session of sessions) {
    const owned = sessionsByOwner.get(session.agentId) ?? [];
    owned.push(session);
    sessionsByOwner.set(session.agentId, owned);
  }
  const selfParentId =
    caller.self.kind === 'code'
      ? caller.self.ownerAgentId
      : (agents.find((agent) => agent.id === caller.self.id)?.parentAgentId ?? null);

  const nodes: GraphNode[] = [];
  for (const agent of agents) {
    nodes.push({
      id: agent.id,
      kind: 'agent',
      parent_id: agent.parentAgentId,
      depth: agent.treeDepth,
      status: agent.status,
      title: agent.title,
      goal: agent.goal.slice(0, GOAL_PREVIEW_CHARS),
      relation: relationOf(
        caller.self,
        selfParentId,
        { id: agent.id, parentId: agent.parentAgentId },
        caller.rootAgentId
      ),
      created_at: agent.createdAt.toISOString(),
    });
    for (const session of sessionsByOwner.get(agent.id) ?? []) {
      nodes.push({
        id: session.id,
        kind: 'code',
        ...(caller.self.kind === 'code' && caller.self.id === session.id
          ? { provider: caller.self.provider }
          : {}),
        parent_id: session.agentId,
        depth: agent.treeDepth + 1,
        status: session.status,
        title: null,
        goal: session.goal.slice(0, GOAL_PREVIEW_CHARS),
        relation: relationOf(
          caller.self,
          selfParentId,
          { id: session.id, parentId: session.agentId },
          caller.rootAgentId
        ),
        created_at: session.createdAt.toISOString(),
      });
    }
  }
  return {
    root_agent_id: caller.rootAgentId,
    self_id: caller.self.id,
    truncated: agents.length >= graphRepo.GRAPH_MAX_NODES,
    agents: nodes,
  };
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export interface GrepInput {
  pattern: string;
  agent_id?: string;
  role?: 'USER' | 'ASSISTANT' | 'TOOL';
  head_limit?: number;
  case_insensitive?: boolean;
  since?: string;
  until?: string;
}

export async function grepGraph(
  caller: GraphCaller,
  input: GrepInput
): Promise<UserDataGrepResult> {
  let path = `agent_trajectories/${caller.rootAgentId}`;
  if (input.agent_id !== undefined) {
    if (!(await inCallerTree(caller, input.agent_id))) throw new AgentGraphError(404, NOT_FOUND);
    path = `${path}/${input.agent_id}`;
  }
  return executeUserDataGrep(caller.userId, {
    source: 'agent_trajectories',
    pattern: input.pattern,
    filters: { path },
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.head_limit !== undefined ? { head_limit: input.head_limit } : {}),
    ...(input.case_insensitive === true ? { '-i': true } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
  });
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/** A live code session swaps its still-valid token for a fresh one. */
export function refreshCodeSessionToken(claims: AgentGraphClaims): {
  token: string;
  expires_at: string;
} {
  const { token, expiresAt } = mintAgentGraphToken({
    sub: claims.sub,
    rootAgentId: claims.rootAgentId,
    ownerAgentId: claims.ownerAgentId,
    sessionId: claims.sessionId,
    provider: claims.provider,
  });
  return { token, expires_at: expiresAt };
}
