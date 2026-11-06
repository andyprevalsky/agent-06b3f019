import { hydrateProgressEstimate } from '../progressEstimate';
import { API_BASE_WITH_PATH, getAuthHeaders } from './client';
import { getAdminAccessToken } from '../impersonation';
import type {
  Agent,
  AgentDetail,
  AgentDetailResponse,
  CreateAgentPayload,
  Message,
  Tool,
} from './types';
import { hydrateAgentDetail } from './hydrateAgentDetail';
import { benchmarkShareToken } from '../benchmarkShare';

function assertAgentDetailIdentity(
  agentId: string,
  data: AgentDetailResponse,
): AgentDetailResponse {
  if (data.agent.agent_id !== agentId) {
    throw new Error(
      `Agent detail identity mismatch: requested ${agentId}, received ${data.agent.agent_id}`,
    );
  }
  return data;
}

export function benchmarkAgentPreviewEnabled(): boolean {
  return import.meta.env.DEV === true || Boolean(import.meta.env.VITEST);
}

// Get all agents
export async function getAllAgents(signal?: AbortSignal): Promise<Agent[]> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents`, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agents');
  }

  const data = await response.json();
  return data.agents.map(hydrateProgressEstimate);
}

/** Search active chats by title, goal, or message content. */
export async function searchAgents(query: string, signal?: AbortSignal): Promise<Agent[]> {
  const headers = getAuthHeaders();
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${API_BASE_WITH_PATH}/agents/search?${params}`, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to search agents');
  }

  const data = await response.json();
  return data.agents.map(hydrateProgressEstimate);
}

// Get agent details with messages
export async function getAgent(
  agentId: string,
  before?: string,
  signal?: AbortSignal,
): Promise<AgentDetailResponse> {
  const headers = getAuthHeaders();
  const url = before
    ? `${API_BASE_WITH_PATH}/agents/${agentId}?before=${before}`
    : `${API_BASE_WITH_PATH}/agents/${agentId}`;

  const response = await fetch(url, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agent');
  }

  return assertAgentDetailIdentity(agentId, hydrateAgentDetail(await response.json()));
}

/** Read one committed message by ID (bounded hydration of a deferred realtime INSERT). */
export async function getAgentMessage(
  agentId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<Message> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/${agentId}/messages/${encodeURIComponent(messageId)}`,
    { headers: getAuthHeaders(), signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch message (${response.status})`);
  }
  const { message } = (await response.json()) as { message: Message };
  if (message.message_id !== messageId) throw new Error('Fetched message identity mismatch');
  return message;
}

export async function getBenchmarkAgentPreview(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentDetailResponse> {
  if (!benchmarkAgentPreviewEnabled()) {
    throw new Error('Benchmark agent preview is disabled');
  }

  const response = await fetch(`${API_BASE_WITH_PATH}/benchmarks/agent-preview/${agentId}`, {
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch benchmark agent preview');
  }

  return assertAgentDetailIdentity(agentId, hydrateAgentDetail(await response.json()));
}

/** Fetch an archived agent using only the run-scoped capability in the URL. */
export async function getBenchmarkSharedAgent(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentDetailResponse> {
  const token = benchmarkShareToken();
  if (!token) throw new Error('Missing benchmark share token');
  const url = `${API_BASE_WITH_PATH}/benchmarks/shared-agent/${encodeURIComponent(agentId)}`;
  const response = await fetch(url, {
    signal,
    headers: { Authorization: `BenchmarkShare ${token}` },
  });
  if (!response.ok) throw new Error('Failed to fetch shared benchmark agent');
  return assertAgentDetailIdentity(agentId, hydrateAgentDetail(await response.json()));
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
    const error = (await response.json()) as { error?: string };
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

/**
 * Archive an agent. This IS the soft delete — DELETE /agents/:id sets
 * `deletedAt` rather than removing the row, so the agent reappears under
 * `getArchivedAgents()` and can be restored.
 */
export const archiveAgent = deleteAgent;

// List archived (soft-deleted) agents, newest archive first.
export async function getArchivedAgents(): Promise<Agent[]> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/archived`, { headers });

  if (!response.ok) {
    throw new Error('Failed to fetch archived agents');
  }

  const data = await response.json();
  return data.agents.map(hydrateProgressEstimate);
}

// Restore an archived agent (does not resume its run)
export async function unarchiveAgent(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/unarchive`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to unarchive agent');
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

export interface ReportAgentBugResult {
  success: true;
  name: string;
  url: string;
  run_id: string;
}

/**
 * Admin-only: run the boxes.dev Bug Report automation to /rca this Rose agent.
 * Uses the admin token so the call still works while impersonating.
 */
export async function reportAgentBug(
  agentId: string,
  description: string,
): Promise<ReportAgentBugResult> {
  const headers = getAuthHeaders();
  const adminToken = getAdminAccessToken();
  if (adminToken !== null) {
    headers.Authorization = `Bearer ${adminToken}`;
  }

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/report-bug`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ description }),
  });

  if (!response.ok) {
    throw await readReportBugError(response, 'Failed to report bug');
  }

  return (await response.json()) as ReportAgentBugResult;
}

export interface BugReportScreenshot {
  success: true;
  name: string;
  /** Signed image URL, valid for `expires_in` seconds. */
  url: string;
  expires_in: number;
}

async function readReportBugError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = (await response.json()) as { error?: string };
    if (typeof data.error === 'string' && data.error !== '') return new Error(data.error);
  } catch {
    // keep fallback
  }
  return new Error(fallback);
}

/** Upload one Report Bug screenshot; the caller embeds the returned URL. */
export async function uploadBugReportScreenshot(
  agentId: string,
  file: File,
): Promise<BugReportScreenshot> {
  // The browser sets the multipart boundary; drop the JSON content type.
  const { 'Content-Type': _json, ...headers } = getAuthHeaders();
  const adminToken = getAdminAccessToken();
  if (adminToken !== null) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const form = new FormData();
  form.append('file', file, file.name);

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/report-bug/screenshots`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!response.ok) {
    throw await readReportBugError(response, 'Failed to upload screenshot');
  }
  return (await response.json()) as BugReportScreenshot;
}

// Update agent configuration
export async function updateAgent(
  agentId: string,
  updates: {
    title?: string | null; // Sidebar rename; null clears back to the generated title
    pinned?: boolean; // Pin/unpin in the sidebar
    model?: string;
    tool_ids?: string[];
    verifier_prompt?: string;
    price_limit_cents?: number; // Price limit in cents (must be >= current tree_cost_cents)
    write_lock_enabled?: boolean;
    /** Move to a project's root (null = Home); resets the folder. */
    project_id?: string | null;
    /** Move into a folder (its project is derived); null = the project's root. */
    folder_id?: string | null;
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
