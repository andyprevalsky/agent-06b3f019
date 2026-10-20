/**
 * Everything a code-agent session gets in its HOME, assembled in one place:
 *
 *   prepareUserUiWorkspaceSafe(userId, agentId)  rose-ui CLI + publish env (W1; no UI folder:
 *     │                                          the agent runs `rose-ui pull` when it needs one)
 *     └─ withAgentGraphWorkspace(...)       rose-agents CLI + graph token   (L-A2A)
 *          └─ withAgentTools(...)           rose CLI / MCP + tools token    (L-DISPLAY)
 *               └─ withCodePreview(...)     rose-preview CLI + env, Rose Desktop accounts only (A1)
 *                    └─ withRoseSkills(...) ~/.rose/skills + ~/.claude/skills + ~/.agents/skills (C17)
 *
 * Each step is best-effort (never throws); a failed step leaves the others.
 * The rose-ui step, rose-preview and the Rose Desktop tool set apply to Rose
 * Desktop accounts only (utils/roseDesktop); `roseDesktop` defaults to that
 * flag and also picks the installed skills, which the code-agent prompt's
 * table of contents lists (codeAgentPrompt, same installedRoseSkills()).
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
  installedRoseSkills,
  isRoseSkillWorkspacePath,
  roseSkillWorkspaceFiles,
} from './roseSkills/skills';
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

/**
 * Install the account group's Rose skills (C17): every skill under
 * ~/.rose/skills/<name>/, mirrored into Claude Code's ~/.claude/skills/ and
 * Codex's ~/.agents/skills/. The prompt's table of contents lists the same set.
 */
export function withRoseSkills(
  workspace: UserUiWorkspace | null,
  roseDesktop: boolean
): UserUiWorkspace | null {
  try {
    const base: UserUiWorkspace = workspace ?? { files: [], envs: {}, source: { kind: 'seed' } };
    return {
      ...base,
      files: [
        ...base.files.filter((file) => !isRoseSkillWorkspacePath(file.path)),
        ...roseSkillWorkspaceFiles(installedRoseSkills(roseDesktop)),
      ],
    };
  } catch (err) {
    log.error('Failed to add the Rose skills', {
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
  return withRoseSkills(
    withCodePreview(
      withAgentTools(graph, { userId, agentId, taskId, provider, roseDesktop }),
      userId,
      roseDesktop
    ),
    roseDesktop
  );
}
