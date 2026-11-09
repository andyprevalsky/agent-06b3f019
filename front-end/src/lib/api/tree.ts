import { API_BASE_WITH_PATH, getAuthHeaders } from './client';
import type { AgentTreeNode, AncestorNode } from './types';

// Get all agents in a sub-agent tree by busId
export async function fetchTreeState(busId: string): Promise<AgentTreeNode[]> {
  const headers = getAuthHeaders();

  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/tree?busId=${encodeURIComponent(busId)}`,
    {
      headers,
    },
  );

  if (!response.ok) {
    throw new Error('Failed to fetch tree state');
  }

  const data = await response.json();
  return data.agents;
}

/** Status of a Claude Code / Codex session (ClaudeCodeSessionStatus). */
export type CodeAgentStatus = 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'ERROR';

/** The CLI a code agent ran; null for legacy rows that never recorded it. */
export type CodeAgentProviderName = 'claude' | 'codex' | null;

/**
 * A code agent (Claude Code / Codex session) in a tree: GET /api/agents/tree
 * lists them in `code_agents`, keyed to the Rose agent that owns the session.
 */
export interface CodeAgentNode {
  code_agent_id: string;
  owner_agent_id: string;
  provider: CodeAgentProviderName;
  goal: string;
  status: CodeAgentStatus;
  created_at: string;
}

/** Most root ids one GET /api/agents/code-agents request may name (backend: 400 above). */
export const CODE_AGENT_LIST_MAX_ROOTS = 50;

/**
 * One row of GET /api/agents/code-agents: a code agent of one of the requested
 * trees (root_agent_id = the tree's root, owner_agent_id = the Rose agent that
 * owns the session). `title` is the spawn's task_name, else (legacy rows) the
 * first line of its goal.
 */
export interface CodeAgentListItem {
  code_agent_id: string;
  owner_agent_id: string;
  root_agent_id: string;
  provider: CodeAgentProviderName;
  status: CodeAgentStatus;
  title: string;
  /** Its container (the code session's sandbox); null when unknown (Mac and legacy runs). */
  container_state?: CodeContainerState | null;
  created_at: string;
}

/** awake = running · stopped = paused, resumes on the next message · destroyed = retired. */
export type CodeContainerState = 'awake' | 'stopped' | 'destroyed';

/**
 * Code agents of up to CODE_AGENT_LIST_MAX_ROOTS trees in one request (the
 * backend returns at most 500 rows, oldest first). Callers chunk larger sets.
 */
export async function fetchCodeAgentsForRoots(rootIds: string[]): Promise<CodeAgentListItem[]> {
  if (rootIds.length === 0) return [];
  if (rootIds.length > CODE_AGENT_LIST_MAX_ROOTS) {
    throw new Error(`At most ${CODE_AGENT_LIST_MAX_ROOTS} roots per code-agents request`);
  }
  const query = rootIds.map(encodeURIComponent).join(',');
  const response = await fetch(`${API_BASE_WITH_PATH}/agents/code-agents?root_ids=${query}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to fetch code agents (${response.status})`);
  const data = (await response.json()) as { code_agents?: CodeAgentListItem[] };
  return Array.isArray(data.code_agents) ? data.code_agents : [];
}

// Get ancestor chain for breadcrumb navigation
export async function fetchAncestors(agentId: string): Promise<AncestorNode[]> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/ancestors`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch ancestors');
  }

  const data = await response.json();
  const rows = Array.isArray(data.ancestors) ? data.ancestors : [];
  return rows
    .map((row: { id?: string; agent_id?: string; goal?: string }) => ({
      id: row.id || row.agent_id || '',
      goal: row.goal ?? '',
    }))
    .filter((row: AncestorNode) => row.id.length > 0);
}
