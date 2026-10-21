import { API_BASE_WITH_PATH, getAuthHeaders } from './client';
import { CodePreviewApiError, type CodePreviewStatus } from './codePreview';

export interface RootPreviewView {
  agent_id: string;
  root_agent_id: string;
  stable_path: string;
  code_session_id: string | null;
  task_id: string | null;
  status: CodePreviewStatus | 'unavailable';
  preview_url: string | null;
  checked_at: string;
}

export function rootPreviewPath(rootId: string): string {
  return `/?agent-id=${encodeURIComponent(rootId)}&browser=local`;
}

export function matchesRootPreview(expected: string | null, actual: string): boolean {
  try {
    if (!expected) return false;
    const target = new URL(expected);
    const handedOff = new URL(actual);
    target.hash = '';
    handedOff.hash = '';
    return target.href === handedOff.href;
  } catch {
    return false;
  }
}

export async function fetchRootPreview(agentId: string): Promise<RootPreviewView> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/${encodeURIComponent(agentId)}/local-preview`,
    { headers: getAuthHeaders() },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new CodePreviewApiError(
      response.status,
      body?.code ?? null,
      body?.error ?? 'Local preview unavailable',
    );
  if (
    !body ||
    body.agent_id !== agentId ||
    typeof body.root_agent_id !== 'string' ||
    body.stable_path !== rootPreviewPath(body.root_agent_id) ||
    !['running', 'paused', 'not_running', 'unknown', 'unavailable'].includes(body.status) ||
    !(body.task_id === null || typeof body.task_id === 'string') ||
    !(body.preview_url === null || typeof body.preview_url === 'string')
  ) {
    throw new Error('Invalid local preview response');
  }
  return body as RootPreviewView;
}
