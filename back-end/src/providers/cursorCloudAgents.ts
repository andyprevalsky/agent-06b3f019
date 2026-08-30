/**
 * Cursor Cloud Agents API client (v1).
 * Docs: https://cursor.com/docs/cloud-agent/api/endpoints
 */

import { createLogger } from './logger';

const log = createLogger('CursorCloudAgents');

/** Bound every Cursor API request so a stalled socket cannot hang Report Bug. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface LaunchCursorCloudAgentInput {
  apiKey: string;
  baseUrl: string;
  name: string;
  promptText: string;
  /** Named Cursor-hosted environment (preferred — carries secrets/setup). */
  envName: string;
}

export interface LaunchedCursorCloudAgent {
  id: string;
  name: string;
  url: string;
  status: string;
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

export async function launchCursorCloudAgent(
  input: LaunchCursorCloudAgentInput
): Promise<LaunchedCursorCloudAgent> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/agents`;
  const body = {
    name: input.name,
    prompt: { text: input.promptText },
    env: { type: 'cloud', name: input.envName },
  };

  // Do not log name/prompt — they carry customer incident text.
  log.info('Launching Cursor cloud agent', {
    env_name: input.envName,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(input.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? JSON.stringify((parsed as { error: unknown }).error)
        : rawText.slice(0, 500);
    log.error('Cursor cloud agent launch failed', {
      status: response.status,
      detail,
    });
    throw new Error(`Cursor API ${response.status}: ${detail || 'launch failed'}`);
  }

  const payload = parsed as {
    agent?: { id?: string; name?: string; url?: string; status?: string };
    id?: string;
    name?: string;
    url?: string;
    status?: string;
  };
  const agent = payload.agent ?? payload;
  const id = typeof agent.id === 'string' ? agent.id : '';
  const name = typeof agent.name === 'string' ? agent.name : input.name;
  const agentUrl =
    typeof agent.url === 'string' && agent.url !== ''
      ? agent.url
      : id !== ''
        ? `https://cursor.com/agents/${id}`
        : '';
  const status = typeof agent.status === 'string' ? agent.status : 'ACTIVE';

  if (id === '' || agentUrl === '') {
    throw new Error('Cursor API returned no agent id');
  }

  log.info('Cursor cloud agent launched', { cursor_agent_id: id, url: agentUrl });
  return { id, name, url: agentUrl, status };
}
