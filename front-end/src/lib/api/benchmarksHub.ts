/**
 * Benchmark Hub API client — team-gated endpoints for the in-app Benchmarks
 * tab (task catalog + stats, metadata edits, run dispatch, run archive).
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface HubTaskStats {
  attempts: number;
  passes: number;
  pass_rate: number | null;
  p50_duration_seconds: number | null;
  p95_duration_seconds: number | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_fast_mode: boolean;
}

export interface HubTask {
  name: string;
  title: string | null;
  description: string | null;
  prompt: string;
  status: string | null;
  bench: string | null;
  group: string;
  tags: string[];
  timeout_seconds: number | null;
  price_limit_cents: number | null;
  expected_tools: string[];
  min_agent_count: number | null;
  is_chat_mode: boolean;
  world_model_mode: string | null;
  updated_at: string;
  updated_by: string | null;
  stats: HubTaskStats | null;
}

export interface HubTaskEdit {
  title?: string;
  description?: string;
  prompt?: string;
  tags?: string[];
  status?: 'ready' | 'incomplete' | null;
  bench?: 'rose-bench' | 'pipeline-e2e';
  timeout_seconds?: number;
  price_limit_cents?: number;
  expected_tools?: string[];
  min_agent_count?: number | null;
  is_chat_mode?: boolean;
}

export interface HubRunTask {
  name: string;
  passed: boolean | null;
  status: string;
  agent_id: string | null;
  duration_seconds: number | null;
  cost_cents: number | null;
  world_model_mode: string | null;
  fast_mode: boolean;
  tree_agent_count: number | null;
  failure_reason: string | null;
}

export interface HubRun {
  run_id: string;
  timestamp: string;
  suite: string | null;
  source: string | null;
  live: boolean;
  uploaded_at: string;
  tasks: HubRunTask[];
}

export interface HubRunRequest {
  id: string;
  taskNames: string[];
  simOn: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  requestedBy: string;
  claimedBy: string | null;
  progress: Record<string, unknown> | null;
  runId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HubRunTaskDetail extends HubRunTask {
  tokens_in: number | null;
  tokens_out: number | null;
  cache_hit_pct: number | null;
  llm_call_count: number | null;
  message_count: number | null;
}

export interface HubRunCost {
  agents_llm_usd: number | null;
  wmh_grounding_usd: number | null;
  infra_usd: number | null;
  total_usd: number | null;
  fast_cache_hit_rate: number | null;
}

export interface HubRunDispatch {
  status: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  updated_at: string;
  error: string | null;
}

export interface HubRunDetail extends Omit<HubRun, 'tasks'> {
  tasks: HubRunTaskDetail[];
  totals: {
    passed: number;
    failed: number;
    running: number;
    cost_cents: number;
    tokens_in: number;
    tokens_out: number;
    agents: number;
  };
  code: string | null;
  elapsed_s: number | null;
  cost: HubRunCost | null;
  dispatch: HubRunDispatch | null;
}

export interface HubTreeNode {
  agent_id: string;
  parent_agent_id: string | null;
  goal: string;
  status: string;
  progress: number;
  tools_in_use: string[];
  message_count: number;
  tree_cost_cents: number;
}

export interface HubAgentMessage {
  message_id: string;
  timestamp: string;
  text: string;
  role: string;
  metadata: Record<string, unknown>;
  file_pointer: unknown;
}

export interface HubAgentView {
  agent: Record<string, unknown> & { agent_id: string; goal?: string; status?: string };
  messages: HubAgentMessage[];
  tree: HubTreeNode[];
}

async function hubFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_WITH_PATH}${path}`, {
    ...init,
    headers: { ...getAuthHeaders(), ...init.headers },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      // non-JSON error body
    }
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchHubTasks(): Promise<HubTask[]> {
  const data = await hubFetch<{ tasks: HubTask[] }>('/benchmarks/tasks');
  return data.tasks;
}

export async function patchHubTask(name: string, edit: HubTaskEdit): Promise<HubTask> {
  const data = await hubFetch<{ task: HubTask }>(`/benchmarks/tasks/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(edit),
  });
  return data.task;
}

export async function fetchHubRuns(): Promise<HubRun[]> {
  const data = await hubFetch<{ runs: HubRun[] }>('/benchmarks/runs');
  return data.runs;
}

export async function fetchHubRunRequests(): Promise<HubRunRequest[]> {
  const data = await hubFetch<{ requests: HubRunRequest[] }>('/benchmarks/run-requests');
  return data.requests;
}

export async function createHubRunRequest(
  taskNames: string[],
  simOn: string[] = [],
): Promise<HubRunRequest> {
  const data = await hubFetch<{ request: HubRunRequest }>('/benchmarks/run-requests', {
    method: 'POST',
    body: JSON.stringify({ task_names: taskNames, ...(simOn.length > 0 ? { sim_on: simOn } : {}) }),
  });
  return data.request;
}

export async function fetchHubRun(runId: string): Promise<HubRunDetail> {
  const data = await hubFetch<{ run: HubRunDetail }>(
    `/benchmarks/runs/${encodeURIComponent(runId)}`,
  );
  return data.run;
}

export async function fetchHubRunAgent(runId: string, agentId: string): Promise<HubAgentView> {
  return hubFetch<HubAgentView>(
    `/benchmarks/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}`,
  );
}
