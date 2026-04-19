import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface BrowserSessionResumeResponse {
  debug_url: string;
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
