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

/**
 * A code agent (Claude Code / Codex session) in a tree: GET /api/agents/tree
 * lists them in `code_agents`, keyed to the Rose agent that owns the session.
 * `provider` is not in the contract yet; readers default to Claude, as the
 * code-agent chip does.
 */
export interface CodeAgentNode {
  code_agent_id: string;
  owner_agent_id: string;
  goal: string;
  status: CodeAgentStatus;
  created_at: string;
  provider?: 'claude' | 'codex' | null;
}

/** The code agents of one tree (root agent id = busId). */
export async function fetchTreeCodeAgents(busId: string): Promise<CodeAgentNode[]> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/tree?busId=${encodeURIComponent(busId)}`,
    { headers: getAuthHeaders() },
  );
  if (!response.ok) throw new Error(`Failed to fetch tree code agents (${response.status})`);
  const data = (await response.json()) as { code_agents?: CodeAgentNode[] };
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
