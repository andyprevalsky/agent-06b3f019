/**
 * Everything a code-agent session gets in its HOME, assembled in one place:
 *
 *   prepareUserUiWorkspaceSafe(userId, agentId)  rose_user_ui/ + rose-ui CLI (W1)
 *     └─ withAgentGraphWorkspace(...)       rose-agents CLI + graph token   (L-A2A)
 *          └─ withAgentTools(...)           rose CLI / MCP + tools token    (L-DISPLAY)
 *               └─ withCodePreview(...)     rose-preview CLI + env, Rose dev accounts only (A1)
 *
 * Each step is best-effort (never throws); a failed step leaves the others.
 */
import { withAgentGraphWorkspace } from './agentGraph/workspace';
import { withAgentTools } from './agentTools/workspace';
import {
  CODE_PREVIEW_CLI_PATH,
  codePreviewLocalEnvs,
  codePreviewSandboxEnvs,
  codePreviewToolFiles,
} from './codePreview/preview';
import { createLogger } from './logger';
import {
  prepareUserUiWorkspaceSafe,
  userUiPublishBaseUrl,
  type UserUiWorkspace,
} from './userUi/workspace';
import { isRoseDevUser } from '../utils/roseDevAccess';

const log = createLogger('CodeSessionWorkspace');

/** Add the live-preview CLI and its env for Rose dev accounts (Rose-in-Rose, A1). */
export function withCodePreview(
  workspace: UserUiWorkspace | null,
  userId: string | undefined
): UserUiWorkspace | null {
  if (!isRoseDevUser(userId)) return workspace;
  try {
    const base: UserUiWorkspace = workspace ?? { files: [], envs: {}, source: { kind: 'seed' } };
    return {
      ...base,
      files: [
        ...base.files.filter((file) => file.path !== CODE_PREVIEW_CLI_PATH),
        ...codePreviewToolFiles(),
      ],
      envs: { ...base.envs, ...codePreviewSandboxEnvs(userUiPublishBaseUrl()) },
      localEnvs: { ...base.localEnvs, ...codePreviewLocalEnvs() },
    };
  } catch (err) {
    log.error('Failed to add the rose-preview CLI', {
      error: err instanceof Error ? err.message : String(err),
    });
    return workspace;
  }
}

export async function prepareCodeSessionWorkspace(
  userId: string | undefined,
  agentId: string,
  taskId: string,
  provider: 'claude' | 'codex'
): Promise<UserUiWorkspace | null> {
  const userUi = await prepareUserUiWorkspaceSafe(userId, agentId, taskId);
  const graph = await withAgentGraphWorkspace(userUi, {
    userId,
    ownerAgentId: agentId,
    sessionId: taskId,
    provider,
  });
  return withCodePreview(withAgentTools(graph, { userId, agentId, taskId, provider }), userId);
}
