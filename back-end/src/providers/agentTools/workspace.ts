/**
 * Install the Rose agent tools into a code-agent session's HOME.
 *
 *   createClaudeCodeSession / createCodexCodeSession(agentId, userId, taskId)
 *     └─ withAgentTools(prepareUserUiWorkspaceSafe(userId, agentId), {userId, agentId, taskId, provider})
 *          rose CLI + MCP server ───────► ~/.rose/bin/rose          (on PATH)
 *          {url, token} ────────────────► ~/.rose/tools.json        (MCP servers may not inherit env)
 *          Claude Code MCP config ──────► ~/.rose/mcp.json          (ws-server passes --mcp-config;
 *                                                                   Codex gets the same server via -c)
 *          MOBBIN_MCP_TOKEN (if set) ───► mobbin in ~/.rose/mcp.json + session env (./mobbin.ts)
 *          change-environment-size ─────► ~/.rose/skills/change-environment-size/SKILL.md (C16)
 *          token scoped to THIS agent ──► ROSE_TOOLS_URL / ROSE_TOOLS_TOKEN env
 *
 * The files ride the existing rose_user_ui materialization (same HOME layout,
 * same sandbox/local writers), so no extra session plumbing is needed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger';
import { isRoseDesktopUser } from '../../utils/roseDesktop';
import {
  USER_UI_CLI_BIN_DIR,
  userUiPublishBaseUrl,
  type UserUiWorkspace,
} from '../userUi/workspace';
import {
  MOBBIN_MCP_SERVER_NAME,
  MOBBIN_MCP_TOKEN_ENV,
  mobbinMcpServerConfig,
  mobbinMcpToken,
} from './mobbin';
import { mintAgentToolsToken, type AgentToolsProvider } from './token';

const log = createLogger('AgentToolsWorkspace');

export const AGENT_TOOLS_CLI_NAME = 'rose';
export const AGENT_TOOLS_CLI_PATH = `${USER_UI_CLI_BIN_DIR}/${AGENT_TOOLS_CLI_NAME}`;
export const AGENT_TOOLS_CONFIG_PATH = '.rose/tools.json';
export const AGENT_TOOLS_MCP_CONFIG_PATH = '.rose/mcp.json';
export const AGENT_TOOLS_ENV_URL = 'ROSE_TOOLS_URL';
/** The `rose env` skill ships with the CLI it documents (C16; the shared skill materializer absorbs it). */
export const ENV_SIZE_SKILL_PATH = '.rose/skills/change-environment-size/SKILL.md';
export const AGENT_TOOLS_ENV_TOKEN = 'ROSE_TOOLS_TOKEN';
/** '1' for Rose Desktop accounts: the CLI/MCP then offers pinned questions and inline views. */
export const AGENT_TOOLS_ENV_ROSE_DESKTOP = 'ROSE_TOOLS_ROSE_DESKTOP';

const SCRIPT_PATH = join(__dirname, '../../assets/rose-tools/rose.cjs');
const ENV_SIZE_SKILL_SOURCE = join(
  __dirname,
  '../../assets/rose-skills/change-environment-size/SKILL.md'
);
let cachedScript: Buffer | null = null;
let cachedEnvSizeSkill: Buffer | null = null;

export function envSizeSkillFile(): Buffer {
  cachedEnvSizeSkill ??= readFileSync(ENV_SIZE_SKILL_SOURCE);
  return cachedEnvSizeSkill;
}

/** The shipped CLI bytes (src/assets in dev, dist/assets after `npm run build`). */
export function agentToolsCliScript(): Buffer {
  cachedScript ??= readFileSync(SCRIPT_PATH);
  return cachedScript;
}

export function agentToolsBasePath(agentId: string): string {
  return `/api/agent-tools/${encodeURIComponent(agentId)}`;
}

/** Same-host sessions call this backend's loopback port. */
export function localAgentToolsUrl(publicUrl: string): string {
  const { pathname } = new URL(publicUrl);
  return `http://127.0.0.1:${process.env.PORT || 3001}${pathname}`;
}

/** Mobbin is listed only with its token in the session env (Claude Code drops a config with an unset ${VAR}). */
function mcpConfig(homeDir: string, envs: Record<string, string>): string {
  return JSON.stringify(
    {
      mcpServers: {
        rose: { command: 'node', args: [`${homeDir}/${AGENT_TOOLS_CLI_PATH}`, 'mcp'] },
        ...(envs[MOBBIN_MCP_TOKEN_ENV]
          ? { [MOBBIN_MCP_SERVER_NAME]: mobbinMcpServerConfig() }
          : {}),
      },
    },
    null,
    2
  );
}

/**
 * ~/.rose/tools.json: MCP servers may not inherit the session env (Codex passes
 * only a fixed set), so the CLI falls back to this file. It also carries the
 * agent-graph URL + token so an agent-routed question can use L-A2A's path.
 */
function toolsConfig(url: string, token: string, envs: Record<string, string> = {}): string {
  return JSON.stringify({
    url,
    token,
    ...(envs.ROSE_AGENTS_URL ? { agents_url: envs.ROSE_AGENTS_URL } : {}),
    ...(envs.ROSE_AGENTS_TOKEN ? { agents_token: envs.ROSE_AGENTS_TOKEN } : {}),
    ...(envs[AGENT_TOOLS_ENV_ROSE_DESKTOP] === '1' ? { rose_desktop: true } : {}),
  });
}

/**
 * Rewrite the HOME-dependent files for a session whose HOME is not the E2B
 * default (the same-host local fallback): loopback URL and absolute CLI path.
 */
export function relocateAgentToolsWorkspace(
  workspace: UserUiWorkspace,
  homeDir: string,
  url: string
): UserUiWorkspace {
  const token = workspace.envs[AGENT_TOOLS_ENV_TOKEN];
  if (!token) return workspace;
  return {
    ...workspace,
    files: workspace.files.map((file) => {
      if (file.path === AGENT_TOOLS_CONFIG_PATH) {
        return {
          path: file.path,
          content: Buffer.from(toolsConfig(url, token, workspace.envs), 'utf8'),
        };
      }
      if (file.path === AGENT_TOOLS_MCP_CONFIG_PATH) {
        return {
          path: file.path,
          content: Buffer.from(mcpConfig(homeDir, workspace.envs), 'utf8'),
        };
      }
      return file;
    }),
    envs: { ...workspace.envs, [AGENT_TOOLS_ENV_URL]: url },
  };
}

/** Same-host local session: loopback tools URL and HOME-relative MCP path. */
export function agentToolsForLocalHome<T extends UserUiWorkspace | null | undefined>(
  workspace: T,
  homeDir: string
): T {
  const publicUrl = workspace?.envs[AGENT_TOOLS_ENV_URL];
  if (!workspace || !publicUrl) return workspace;
  return relocateAgentToolsWorkspace(workspace, homeDir, localAgentToolsUrl(publicUrl)) as T;
}

/**
 * Returns the workspace with the tools added. A missing UI workspace (its
 * preparation failed) yields a tools-only workspace. Never throws: the tools
 * must not block a code session.
 */
export function withAgentTools(
  workspace: UserUiWorkspace | null,
  session: {
    userId: string | undefined;
    agentId: string;
    taskId: string;
    provider: AgentToolsProvider;
    homeDir?: string;
    /** Rose Desktop tools (pinned questions, inline views); defaults to the account's flag. */
    roseDesktop?: boolean;
  }
): UserUiWorkspace | null {
  if (!session.userId) return workspace;
  try {
    const { token } = mintAgentToolsToken(session.userId, session.agentId, {
      provider: session.provider,
      taskId: session.taskId,
    });
    const url = `${userUiPublishBaseUrl()}${agentToolsBasePath(session.agentId)}`;
    const homeDir = session.homeDir ?? '/home/user';
    const base: UserUiWorkspace = workspace ?? { files: [], envs: {}, source: { kind: 'seed' } };
    // Pinned questions and inline views need the Rose Desktop UI; stock
    // sessions get the stock tool list (rose.cjs reads this flag).
    const featureEnvs: Record<string, string> =
      (session.roseDesktop ?? isRoseDesktopUser(session.userId))
        ? { [AGENT_TOOLS_ENV_ROSE_DESKTOP]: '1' }
        : {};
    const mobbinToken = mobbinMcpToken();
    const envs = {
      ...base.envs,
      ...featureEnvs,
      ...(mobbinToken ? { [MOBBIN_MCP_TOKEN_ENV]: mobbinToken } : {}),
    };
    const owned = new Set([
      AGENT_TOOLS_CLI_PATH,
      AGENT_TOOLS_CONFIG_PATH,
      AGENT_TOOLS_MCP_CONFIG_PATH,
      ENV_SIZE_SKILL_PATH,
    ]);
    return {
      ...base,
      files: [
        ...base.files.filter((file) => !owned.has(file.path)),
        { path: AGENT_TOOLS_CLI_PATH, content: agentToolsCliScript() },
        {
          path: AGENT_TOOLS_CONFIG_PATH,
          content: Buffer.from(toolsConfig(url, token, envs), 'utf8'),
        },
        {
          path: AGENT_TOOLS_MCP_CONFIG_PATH,
          content: Buffer.from(mcpConfig(homeDir, envs), 'utf8'),
        },
        { path: ENV_SIZE_SKILL_PATH, content: envSizeSkillFile() },
      ],
      envs: { ...envs, [AGENT_TOOLS_ENV_URL]: url, [AGENT_TOOLS_ENV_TOKEN]: token },
      localEnvs: { ...base.localEnvs, [AGENT_TOOLS_ENV_URL]: localAgentToolsUrl(url) },
    };
  } catch (err) {
    log.error('Failed to add Rose agent tools', {
      agentId: session.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return workspace;
  }
}
