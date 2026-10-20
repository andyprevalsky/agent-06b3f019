/**
 * Add the `rose-display` CLI to a code-agent session's workspace.
 *
 *   createClaudeCodeSession / createCodexCodeSession(agentId, userId)
 *     └─ withDisplayCli(prepareUserUiWorkspaceSafe(userId), userId, agentId)
 *          rose-display CLI ───────────────► ~/.rose/bin/rose-display (on PATH)
 *          token scoped to THIS agent ─────► ROSE_DISPLAY_URL / ROSE_DISPLAY_TOKEN
 *
 * The CLI rides the existing rose_user_ui materialization (same HOME layout,
 * same sandbox/local writers), so it needs no extra session plumbing.
 */
import { createLogger } from '../logger';
import {
  USER_UI_CLI_BIN_DIR,
  userUiPublishBaseUrl,
  type UserUiWorkspace,
} from '../userUi/workspace';
import { DISPLAY_CLI_NAME, DISPLAY_CLI_SCRIPT } from './cli';
import { mintDisplayToken } from './displayToken';

const log = createLogger('DisplayWorkspace');

export const DISPLAY_CLI_PATH = `${USER_UI_CLI_BIN_DIR}/${DISPLAY_CLI_NAME}`;

export function displayPostPath(agentId: string): string {
  return `/api/display/${encodeURIComponent(agentId)}`;
}

/** Same-host sessions post to this backend's loopback port. */
export function localDisplayPostUrl(agentId: string): string {
  return `http://127.0.0.1:${process.env.PORT || 3001}${displayPostPath(agentId)}`;
}

/**
 * Returns the workspace with the CLI file + env added. A missing UI workspace
 * (preparation failed) yields a CLI-only workspace so display still works.
 * Never throws: display must not block a code session.
 */
export function withDisplayCli(
  workspace: UserUiWorkspace | null,
  userId: string | undefined,
  agentId: string
): UserUiWorkspace | null {
  if (!userId) return workspace;
  try {
    const { token } = mintDisplayToken(userId, agentId);
    const base: UserUiWorkspace = workspace ?? { files: [], envs: {}, source: { kind: 'seed' } };
    return {
      ...base,
      files: [
        ...base.files.filter((file) => file.path !== DISPLAY_CLI_PATH),
        { path: DISPLAY_CLI_PATH, content: Buffer.from(DISPLAY_CLI_SCRIPT, 'utf8') },
      ],
      envs: {
        ...base.envs,
        ROSE_DISPLAY_URL: `${userUiPublishBaseUrl()}${displayPostPath(agentId)}`,
        ROSE_DISPLAY_TOKEN: token,
      },
    };
  } catch (err) {
    log.error('Failed to add rose-display CLI', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return workspace;
  }
}
