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
  return data.ancestors;
}
