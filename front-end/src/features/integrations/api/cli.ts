import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';

export interface CliIntegration {
  id: string;
  name: string;
  request: string;
  status: 'setting_up' | 'connected' | 'failed';
  agent_id: string | null;
  error: string | null;
}

async function cliResponse<T>(response: Response): Promise<T> {
  let payload: T & { error?: string };
  try {
    payload = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error(response.ok ? 'Unexpected CLI response' : 'Could not connect CLI');
  }
  if (!response.ok) throw new Error(payload?.error || 'Could not connect CLI');
  return payload;
}

export async function fetchCliIntegrations(): Promise<CliIntegration[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/cli`, {
    headers: getAuthHeaders(),
  });
  const { integrations } = await cliResponse<{ integrations?: unknown }>(response);
  if (!Array.isArray(integrations)) throw new Error('Unexpected CLI response');
  return integrations as CliIntegration[];
}

export async function connectCli(request: string, requestId: string): Promise<CliIntegration> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/cli`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ request, request_id: requestId }),
  });
  return (await cliResponse<{ integration: CliIntegration }>(response)).integration;
}
