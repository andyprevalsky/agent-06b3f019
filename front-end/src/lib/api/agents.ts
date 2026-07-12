import { API_BASE_WITH_PATH, getAuthHeaders } from './client';
import type { Agent, AgentDetail, CreateAgentPayload, Message, Tool } from './types';

export function benchmarkAgentPreviewEnabled(): boolean {
  return import.meta.env.DEV === true || Boolean(import.meta.env.VITEST);
}

// Get all agents
export async function getAllAgents(): Promise<Agent[]> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agents');
  }

  const data = await response.json();
  return data.agents;
}

// Get agent details with messages
export async function getAgent(
  agentId: string,
  before?: string,
): Promise<{
  agent: AgentDetail;
  messages: Message[];
  pagination: {
    has_more: boolean;
    oldest_timestamp: string | null;
  };
}> {
  const headers = getAuthHeaders();
  const url = before
    ? `${API_BASE_WITH_PATH}/agents/${agentId}?before=${before}`
    : `${API_BASE_WITH_PATH}/agents/${agentId}`;

  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agent');
  }

  return await response.json();
}

export async function getBenchmarkAgentPreview(agentId: string): Promise<{
  agent: AgentDetail;
  messages: Message[];
  pagination: {
    has_more: boolean;
    oldest_timestamp: string | null;
  };
}> {
  if (!benchmarkAgentPreviewEnabled()) {
    throw new Error('Benchmark agent preview is disabled');
  }

  const response = await fetch(`${API_BASE_WITH_PATH}/benchmarks/agent-preview/${agentId}`);

  if (!response.ok) {
    throw new Error('Failed to fetch benchmark agent preview');
  }

  return await response.json();
}

// Create a new agent
export async function createAgent(payload: CreateAgentPayload): Promise<Agent> {
  const headers = getAuthHeaders();
  const source = payload.source ?? 'WEB';

  const response = await fetch(`${API_BASE_WITH_PATH}/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, source }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create agent');
  }

  return await response.json();
}

// Delete an agent
export async function deleteAgent(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to delete agent');
  }
}

// Generate LLM judge prompt from goal
export async function generateLLMJudgePrompt(goal: string): Promise<string> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/generate-llm-judge-prompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ goal }),
  });

  if (!response.ok) {
    const error = await response.json();
    // Show more detailed error if available
    const errorMessage = error.details || error.error || 'Failed to generate prompt';
    throw new Error(errorMessage);
  }

  const data = await response.json();
  return data.prompt;
}

// Get all available tools
export async function getTools(): Promise<Tool[]> {
  // Tools endpoint is public (no auth required)
  const response = await fetch(`${API_BASE_WITH_PATH}/tools`);

  if (!response.ok) {
    throw new Error('Failed to fetch tools');
  }

  const data = await response.json();
  return data.tools;
}

// Pause agent
export async function pauseAgent(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/pause`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to pause agent');
  }
}

// Resume agent
export async function resumeAgent(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/resume`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to resume agent');
  }
}

// Update agent configuration
export async function updateAgent(
  agentId: string,
  updates: {
    model?: string;
    tool_ids?: string[];
    verifier_prompt?: string;
    price_limit_cents?: number; // Price limit in cents (must be >= current tree_cost_cents)
    write_lock_enabled?: boolean;
  },
): Promise<AgentDetail> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error('Failed to update agent');
  }

  const data = await response.json();
  return data.agent;
}
