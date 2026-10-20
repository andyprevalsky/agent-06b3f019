/**
 * Preview status for one code-agent task (see preview.ts for the model).
 * Kept apart from preview.ts so the session-workspace path, which installs
 * the CLI, does not import the local-session runtime.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { isLocalClaudeCodeSandboxId, resolveLocalSessionWorkDir } from '../claudeCodeLocalSession';
import { isLocalDeviceSandboxId } from '../localDevices/hub';
import {
  CODE_PREVIEW_PORT,
  CODE_PREVIEW_STATE_PATH,
  e2bPreviewUrl,
  type CodePreviewStatus,
  type CodePreviewView,
} from './preview';

const PROBE_TIMEOUT_MS = 2_500;

async function probe(url: string, fetchImpl: typeof fetch): Promise<CodePreviewStatus> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    // A sandbox proxy answers 502/503/504 when nothing listens on the port.
    return response.status >= 500 ? 'not_running' : 'running';
  } catch {
    return 'not_running';
  }
}

async function localStatePort(home: string): Promise<number | null> {
  try {
    const state = JSON.parse(await readFile(join(home, CODE_PREVIEW_STATE_PATH), 'utf8')) as {
      port?: unknown;
    };
    const port = Number(state.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export interface TaskPreviewInput {
  taskId: string;
  sandboxId: string;
  streamUrl: string | null;
  codeSession: {
    id: string;
    state: string;
    sandboxKind: string | null;
    sandboxId: string | null;
    homeDir: string | null;
  } | null;
}

/** Where this task's preview is served, and (optionally) whether it answers. */
export async function resolveTaskPreview(
  input: TaskPreviewInput,
  opts: { probe?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<CodePreviewView> {
  const base = {
    task_id: input.taskId,
    code_session_id: input.codeSession?.id ?? null,
    checked_at: new Date().toISOString(),
  };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const shouldProbe = opts.probe !== false;
  if (isLocalDeviceSandboxId(input.sandboxId)) {
    // The Mac serves it on its own loopback (ROSE_PREVIEW_PORT); only the Mac can check it.
    return {
      ...base,
      target: 'local',
      preview_url: `http://localhost:${CODE_PREVIEW_PORT}/`,
      port: CODE_PREVIEW_PORT,
      status: 'unknown',
    };
  }
  if (isLocalClaudeCodeSandboxId(input.sandboxId)) {
    const home = input.codeSession?.homeDir ?? resolveLocalSessionWorkDir(input.taskId);
    const port = await localStatePort(home);
    if (port === null) {
      return { ...base, target: 'local', preview_url: null, port: null, status: 'not_running' };
    }
    const url = `http://127.0.0.1:${port}/`;
    return {
      ...base,
      target: 'local',
      preview_url: url,
      port,
      status: shouldProbe ? await probe(url, fetchImpl) : 'unknown',
    };
  }
  // The session's current sandbox (a later spawn may have resumed it elsewhere).
  const sandboxId =
    input.codeSession?.sandboxKind === 'e2b' && input.codeSession.sandboxId
      ? input.codeSession.sandboxId
      : input.sandboxId;
  const url = e2bPreviewUrl(input.streamUrl, sandboxId);
  const sessionState = input.codeSession?.state;
  let status: CodePreviewStatus;
  if (sessionState === 'PAUSED') status = 'paused';
  else if (sessionState === 'RETIRED') status = 'not_running';
  else status = shouldProbe ? await probe(url, fetchImpl) : 'unknown';
  return { ...base, target: 'cloud', preview_url: url, port: CODE_PREVIEW_PORT, status };
}
