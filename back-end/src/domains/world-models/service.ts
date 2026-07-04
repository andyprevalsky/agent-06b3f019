import type { NewWorldModelSessionRequest, WorldModelStepRequest } from './types';
import { getWorldModelHarnessBaseUrl } from './config';

async function proxyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getWorldModelHarnessBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail =
      parsed !== null && typeof parsed === 'object' && 'detail' in parsed
        ? String((parsed as { detail?: unknown }).detail)
        : text;
    throw new Error(`WMH request failed: ${response.status} ${detail}`);
  }
  return parsed as T;
}

export async function listWorldModels(): Promise<{ world_models: string[] }> {
  return proxyJson<{ world_models: string[] }>('/world_models');
}

export async function createSession(
  worldModelName: string,
  body: NewWorldModelSessionRequest
): Promise<{ session_id: string }> {
  return proxyJson<{ session_id: string }>(
    `/world_models/${encodeURIComponent(worldModelName)}/sessions`,
    {
      method: 'POST',
      body: JSON.stringify({
        task: body.task ?? null,
        seed_state: body.seed_state ?? null,
      }),
    }
  );
}

export async function stepSession(
  worldModelName: string,
  sessionId: string,
  body: WorldModelStepRequest
): Promise<{ observation: Record<string, unknown> }> {
  return proxyJson<{ observation: Record<string, unknown> }>(
    `/world_models/${encodeURIComponent(worldModelName)}/sessions/${encodeURIComponent(sessionId)}/step`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}
