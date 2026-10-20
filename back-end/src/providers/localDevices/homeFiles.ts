/**
 * The session HOME a local (Mac) code agent gets: the same workspace an E2B
 * session gets (rose_user_ui + `rose-ui`, `rose-agents` graph CLI, `rose`
 * agent-tools CLI/MCP), relocated to the Mac's session HOME and shipped in
 * `start_session.home_files`. Tokens are scoped to this agent/session, exactly
 * as in the sandbox; they reach the backend over its public URL.
 */
import { prepareCodeSessionWorkspace } from '../codeSessionWorkspace';
import { AGENT_TOOLS_ENV_URL, relocateAgentToolsWorkspace } from '../agentTools/workspace';
import { USER_UI_CLI_BIN_DIR, type UserUiWorkspace } from '../userUi/workspace';
import type { LocalCodeProvider, LocalHomeFile } from './protocol';

export interface LocalHome {
  files: LocalHomeFile[];
  envs: Record<string, string>;
}

/** Relocate a code-session workspace to `homeDir` and encode it for the wire. */
export function localHomeFromWorkspace(
  workspace: UserUiWorkspace | null,
  homeDir: string
): LocalHome {
  if (workspace === null) return { files: [], envs: {} };
  const publicToolsUrl = workspace.envs[AGENT_TOOLS_ENV_URL];
  const relocated =
    publicToolsUrl !== undefined && publicToolsUrl !== ''
      ? relocateAgentToolsWorkspace(workspace, homeDir, publicToolsUrl)
      : workspace;
  return {
    files: relocated.files.map((file) => ({
      path: file.path,
      content_base64: file.content.toString('base64'),
      executable: file.path.startsWith(`${USER_UI_CLI_BIN_DIR}/`),
    })),
    envs: { ...relocated.envs },
  };
}

/**
 * Best-effort, like the sandbox path: a Mac that did not report its session
 * root (older app) still runs the session, just without the in-session tools.
 */
export async function prepareLocalHome(params: {
  userId: string;
  agentId: string;
  taskId: string;
  provider: LocalCodeProvider;
  homeDir: string | null;
}): Promise<LocalHome> {
  if (params.homeDir === null) return { files: [], envs: {} };
  const workspace = await prepareCodeSessionWorkspace(
    params.userId,
    params.agentId,
    params.taskId,
    params.provider
  );
  return localHomeFromWorkspace(workspace, params.homeDir);
}
