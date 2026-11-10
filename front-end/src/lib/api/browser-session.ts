import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface BrowserSessionResumeResponse {
  debug_url: string;
}

export type BrowserControlState = 'agent' | 'requested' | 'user';

export interface BrowserControlSnapshot {
  state: BrowserControlState;
  agentPaused: boolean;
  debugUrl: string | null;
}

export async function readBrowserControlState(taskId: string): Promise<BrowserControlSnapshot> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/browser-session/task/${encodeURIComponent(taskId)}/control`,
    { headers: getAuthHeaders() },
  );
  if (!response.ok) throw new Error('Failed to read browser control state');
  return (await response.json()) as BrowserControlSnapshot;
}

/** GET .../live-view — the task's current provider session plus provider liveness. */
export interface BrowserLiveView {
  taskId: string;
  sessionId: string;
  debugUrl: string | null;
  status: string;
  live: boolean | null;
  asOf: number;
}

export async function readBrowserLiveView(taskId: string): Promise<BrowserLiveView> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/browser-session/task/${encodeURIComponent(taskId)}/live-view`,
    { headers: getAuthHeaders() },
  );
  if (!response.ok) throw new Error(`Failed to read browser live view (${response.status})`);
  return (await response.json()) as BrowserLiveView;
}

async function setBrowserControlMode(
  taskId: string,
  mode: 'user' | 'agent',
): Promise<BrowserControlSnapshot> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/browser-session/task/${encodeURIComponent(taskId)}/control`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mode }),
    },
  );
  if (!response.ok) throw new Error(`Failed to give browser control to ${mode}`);
  return (await response.json()) as BrowserControlSnapshot;
}

export async function takeBrowserControl(taskId: string): Promise<BrowserControlSnapshot> {
  const snapshot = await setBrowserControlMode(taskId, 'user');
  if (snapshot.state !== 'user') {
    throw new Error('Browser agent did not hand control over in time');
  }
  return snapshot;
}

export async function releaseBrowserControl(taskId: string): Promise<void> {
  await setBrowserControlMode(taskId, 'agent');
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export async function resizeBrowserSessionViewport(
  taskId: string,
  viewport: BrowserViewport,
): Promise<void> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/browser-session/task/${encodeURIComponent(taskId)}/viewport`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(viewport),
    },
  );

  if (!response.ok) {
    throw new Error('Failed to resize browser viewport');
  }
}

export async function resumeBrowserSession(taskId: string): Promise<BrowserSessionResumeResponse> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/browser-session/resume`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ task_id: taskId }),
  });

  if (!response.ok) {
    throw new Error('Failed to resume session');
  }

  return (await response.json()) as BrowserSessionResumeResponse;
}

export type BrowserNavigationAction = 'back' | 'forward' | 'reload';

/** Navigate the page in the selected remote session, preserving its history and login. */
export async function navigateBrowserSession(
  taskId: string,
  action: BrowserNavigationAction,
): Promise<{ url: string | null }> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/browser-session/task/${encodeURIComponent(taskId)}/navigation`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action }),
    },
  );
  if (!response.ok) throw new Error(`Browser navigation failed (${response.status})`);
  return (await response.json()) as { url: string | null };
}
