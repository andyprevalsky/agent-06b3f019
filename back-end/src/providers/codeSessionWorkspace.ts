/**
 * Everything a code-agent session gets in its HOME, assembled in one place:
 *
 *   prepareUserUiWorkspaceSafe(userId, agentId)  rose_user_ui/ + rose-ui CLI (W1)
 *     └─ withAgentGraphWorkspace(...)       rose-agents CLI + graph token   (L-A2A)
 *          └─ withAgentTools(...)           rose CLI / MCP + tools token    (L-DISPLAY)
 *               └─ withCodePreview(...)     rose-preview CLI + env, Rose Desktop accounts only (A1)
 *
 * Each step is best-effort (never throws); a failed step leaves the others.
 * The rose_user_ui step and the Rose Desktop tool set apply to Rose Desktop
 * accounts only (utils/roseDesktop); `roseDesktop` defaults to that flag.
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
import { isRoseDesktopUser } from '../utils/roseDesktop';

const log = createLogger('CodeSessionWorkspace');

/**
 * Add the live-preview CLI and its env for Rose Desktop accounts (Rose-in-Rose, A1).
 * `roseDesktop` defaults to the account's flag (utils/roseDesktop).
 */
export function withCodePreview(
  workspace: UserUiWorkspace | null,
  userId: string | undefined,
  roseDesktop: boolean = isRoseDesktopUser(userId)
): UserUiWorkspace | null {
  if (!roseDesktop) return workspace;
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
  provider: 'claude' | 'codex',
  roseDesktop: boolean = isRoseDesktopUser(userId)
): Promise<UserUiWorkspace | null> {
  const graph = await withAgentGraphWorkspace(
    await prepareUserUiWorkspaceSafe(userId, agentId, roseDesktop),
    {
      userId,
      ownerAgentId: agentId,
      sessionId: taskId,
      provider,
    }
  );
  return withCodePreview(
    withAgentTools(graph, { userId, agentId, taskId, provider, roseDesktop }),
    userId,
    roseDesktop
  );
}
