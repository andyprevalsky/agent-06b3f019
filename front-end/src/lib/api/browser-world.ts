/**
 * Browser world API (plan row A6): the user's Root browser and the per-site
 * world state agents fork from and merge into. Types mirror the backend
 * views byte for byte (back-end/src/domains/browser-world/types.ts and
 * providers/browser/worldState.ts SiteMergeReceipt).
 *
 *   GET    /browser-world/root             {root|null, sites}
 *   POST   /browser-world/root/open        {start_url?} -> {root}
 *   POST   /browser-world/root/close       -> {root: null, world_state}
 *   GET    /browser-world/sites            {sites}
 *   DELETE /browser-world/sites/:site      {forgotten}
 *   GET    /browser-world/agents/:agentId  {agent_id, tasks}
 *
 * Taking over any tab uses the existing browser-session live-view/control
 * routes (lib/api/browser-session.ts); every view carries their paths.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export type ForkState =
  'forked' | 'merged' | 'unchanged' | 'no_login' | 'signed_out' | 'no_login_signal' | 'stale';

export type SiteMergeOutcome = Exclude<ForkState, 'forked'>;

export interface RootSiteView {
  site: string;
  revision: number;
  cookie_count: number;
  updated_at: string;
  last_writer: { kind: string | null; task_id: string | null; agent_id: string | null };
}

export interface BrowserTaskLinks {
  live_view_path: string;
  control_path: string;
}

export interface RootBrowserView extends BrowserTaskLinks {
  task_id: string;
  session_id: string;
  status: string;
  provider: string;
  live_view_url: string | null;
  forked_sites: number;
}

export interface ForkView {
  site: string;
  state: ForkState;
  base_revision: number;
  merged_revision: number | null;
  root_revision: number;
  forked_at: string;
  merged_at: string | null;
}

export interface AgentBrowserTaskView extends BrowserTaskLinks {
  task_id: string;
  session_id: string;
  status: string;
  live_view_url: string | null;
  sites: ForkView[];
}

export interface SiteMergeReceipt {
  site: string;
  outcome: SiteMergeOutcome;
  base_revision: number;
  head_revision: number;
  merged_revision: number | null;
}

export interface WorldStateMergeReceipt {
  task_id: string;
  kind: 'agent' | 'root';
  sites: SiteMergeReceipt[];
}

export interface RootBrowserState {
  root: RootBrowserView | null;
  sites: RootSiteView[];
}

const BASE = `${API_BASE_WITH_PATH}/browser-world`;

async function request<T>(path: string, init: RequestInit, what: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to ${what} (${response.status})`);
  return (await response.json()) as T;
}

export function readRootBrowser(): Promise<RootBrowserState> {
  return request<RootBrowserState>('/root', {}, 'read the Root browser');
}

export async function openRootBrowser(startUrl?: string): Promise<RootBrowserView> {
  const body = startUrl === undefined ? {} : { start_url: startUrl };
  const { root } = await request<{ root: RootBrowserView }>(
    '/root/open',
    { method: 'POST', body: JSON.stringify(body) },
    'open the Root browser',
  );
  return root;
}

export async function closeRootBrowser(): Promise<WorldStateMergeReceipt | null> {
  const { world_state } = await request<{ world_state: WorldStateMergeReceipt | null }>(
    '/root/close',
    { method: 'POST', body: '{}' },
    'close the Root browser',
  );
  return world_state;
}

export async function listRootSites(): Promise<RootSiteView[]> {
  const { sites } = await request<{ sites: RootSiteView[] }>('/sites', {}, 'list Root sites');
  return sites;
}

export async function forgetRootSite(site: string): Promise<boolean> {
  const { forgotten } = await request<{ forgotten: boolean }>(
    `/sites/${encodeURIComponent(site)}`,
    { method: 'DELETE' },
    `forget ${site}`,
  );
  return forgotten;
}

export async function readAgentBrowserWorld(agentId: string): Promise<AgentBrowserTaskView[]> {
  const { tasks } = await request<{ agent_id: string; tasks: AgentBrowserTaskView[] }>(
    `/agents/${encodeURIComponent(agentId)}`,
    {},
    "read the agent's browser world",
  );
  return tasks;
}
