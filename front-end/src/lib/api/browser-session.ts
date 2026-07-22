import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface BrowserSessionResumeResponse {
  debug_url: string;
}

export type BrowserControlState = 'agent' | 'requested' | 'user';
const CONTROL_HANDOFF_POLL_ATTEMPTS = 480;

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
  let snapshot = await setBrowserControlMode(taskId, 'user');
  for (
    let attempt = 0;
    snapshot.state !== 'user' && attempt < CONTROL_HANDOFF_POLL_ATTEMPTS;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot =
      attempt > 0 && attempt % 20 === 0
        ? await setBrowserControlMode(taskId, 'user')
        : await readBrowserControlState(taskId);
  }
  if (snapshot.state !== 'user') {
    await setBrowserControlMode(taskId, 'agent').catch(() => {});
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
