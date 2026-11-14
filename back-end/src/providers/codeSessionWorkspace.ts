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
import { mobbinAvailableFor } from './agentTools/mobbin';
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
import { prisma } from './database';
import { basename } from 'node:path';

const log = createLogger('CodeSessionWorkspace');

/** Install only broker wrappers; actual binaries arrive in the user's native template. */
export function withNativeCliWrappers(
  workspace: UserUiWorkspace | null,
  rows: Array<{ id: string; config: unknown }>
): UserUiWorkspace | null {
  if (!workspace) return workspace;
  const files = [...workspace.files];
  const reserved = new Set([
    'rose',
    'rose-ui',
    'rose-agents',
    'rose-preview',
    'node',
    'sh',
    'bash',
  ]);
  for (const row of rows) {
    const config = row.config;
    if (
      !config ||
      typeof config !== 'object' ||
      !('native_template' in config) ||
      config.native_template !== true ||
      !('command' in config) ||
      typeof config.command !== 'string' ||
      !config.command.startsWith('/')
    )
      continue;
    if (
      'credential_files' in config &&
      Array.isArray(config.credential_files) &&
      config.credential_files.length === 0
    )
      continue;
    const name = basename(config.command);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
      reserved.has(name) ||
      !/^[a-zA-Z0-9-]+$/.test(row.id)
    )
      continue;
    const path = `.rose/bin/${name}`;
    if (files.some((file) => file.path === path)) continue;
    files.push({
      path,
      content: Buffer.from(
        `#!/bin/sh\nexec node "$HOME/.rose/bin/rose" cli native '${row.id}' -- "$@"\n`
      ),
    });
  }
  if (files.some((file) => file.path.startsWith('.rose/bin/') && !workspace.files.includes(file))) {
    files.push({
      path: '.rose/native-cli-env.sh',
      content: Buffer.from(
        '# Keep connected CLI wrappers ahead of installer-added login-shell paths.\nexport PATH="/home/user/.rose/bin:$PATH"\n'
      ),
    });
  }
  return { ...workspace, files };
}

async function withUserNativeClis(
  workspace: UserUiWorkspace | null,
  userId: string | undefined,
  taskId: string
) {
  if (!userId || !workspace) return workspace;
  workspace = { ...workspace, envs: { ...workspace.envs, ROSE_CLI_TASK_ID: taskId } };
  try {
    const rows = await prisma.integration.findMany({
      where: { userId, name: 'cli', type: 'TOOL_SETUP', status: 'CONNECTED' },
      select: { id: true, config: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return withNativeCliWrappers(workspace, rows);
  } catch (error) {
    log.error('Failed to install native CLI wrappers', {
      error: error instanceof Error ? error.message : String(error),
    });
    return workspace;
  }
}

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

/**
 * The account-dependent code-agent prompt switches, from the same gates that
 * decide what prepareCodeSessionWorkspace installs: Rose Desktop skills and the
 * Mobbin server. The prompt never names a tool the session lacks.
 */
export function promptFlagsForUser(userId: string | undefined) {
  return { roseDesktop: isRoseDesktopUser(userId), mobbin: mobbinAvailableFor(userId) };
}

export async function prepareCodeSessionWorkspace(
  userId: string | undefined,
  agentId: string,
  taskId: string,
  provider: 'claude' | 'codex',
  roseDesktop: boolean = isRoseDesktopUser(userId)
): Promise<UserUiWorkspace | null> {
  const graph = await withAgentGraphWorkspace(
    await prepareUserUiWorkspaceSafe(userId, agentId, roseDesktop, taskId),
    {
      userId,
      ownerAgentId: agentId,
      sessionId: taskId,
      provider,
    }
  );
  return withUserNativeClis(
    withRoseSkills(
      withCodePreview(
        withAgentTools(graph, { userId, agentId, taskId, provider, roseDesktop }),
        userId,
        roseDesktop
      ),
      roseDesktop
    ),
    userId,
    taskId
  );
}
