/**
 * Install the `rose-agents` CLI + a scoped graph token into a code session.
 *
 *   createClaudeCodeSession / createCodexCodeSession(userId, agentId, taskId)
 *     └─ withAgentGraphWorkspace(userUiWorkspace, …)
 *          root = walk parentAgentId from agentId ──► token claims
 *          rose-agents CLI ─────────────────────────► ~/.rose/bin/rose-agents
 *          ROSE_AGENTS_URL / _TOKEN / ROSE_AGENT_ID ─► sandbox env
 *
 * Rides on the session-HOME workspace that already carries rose_user_ui, so
 * E2B and the local fallback write and PATH it the same way. A same-host
 * (local fallback) session gets the loopback URL via `localEnvs`.
 */
import { createLogger } from '../logger';
import {
  USER_UI_CLI_BIN_DIR,
  userUiPublishBaseUrl,
  type UserUiWorkspace,
} from '../userUi/workspace';
import { findGraphRootId } from './tree';
import { AGENT_GRAPH_CLI_NAME, AGENT_GRAPH_CLI_SCRIPT } from './cli';
import { mintAgentGraphToken } from './token';

const log = createLogger('AgentGraphWorkspace');

export const AGENT_GRAPH_ROUTE_PREFIX = '/api/agent-graph';
export const AGENT_GRAPH_CLI_PATH = `${USER_UI_CLI_BIN_DIR}/${AGENT_GRAPH_CLI_NAME}`;

export interface AgentGraphSessionInput {
  userId: string | undefined;
  ownerAgentId: string;
  sessionId: string;
  provider: 'claude' | 'codex';
}

export async function prepareAgentGraphWorkspace(
  input: AgentGraphSessionInput & { userId: string }
): Promise<UserUiWorkspace | null> {
  const rootAgentId = await findGraphRootId(input.ownerAgentId, input.userId);
  if (rootAgentId === null) return null;
  const { token } = mintAgentGraphToken({
    sub: input.userId,
    rootAgentId,
    ownerAgentId: input.ownerAgentId,
    sessionId: input.sessionId,
    provider: input.provider,
    accountAccess: true,
  });
  return {
    files: [
      {
        path: AGENT_GRAPH_CLI_PATH,
        content: Buffer.from(AGENT_GRAPH_CLI_SCRIPT, 'utf8'),
      },
    ],
    envs: {
      ROSE_AGENTS_URL: `${userUiPublishBaseUrl()}${AGENT_GRAPH_ROUTE_PREFIX}`,
      ROSE_AGENTS_TOKEN: token,
      ROSE_AGENT_ID: input.sessionId,
    },
    localEnvs: {
      ROSE_AGENTS_URL: `http://127.0.0.1:${process.env.PORT || 3001}${AGENT_GRAPH_ROUTE_PREFIX}`,
    },
    source: { kind: 'seed' },
  };
}

function mergeWorkspaces(
  base: UserUiWorkspace | null,
  extra: UserUiWorkspace | null
): UserUiWorkspace | null {
  if (extra === null) return base;
  if (base === null) return extra;
  return {
    ...base,
    files: [...base.files.filter((file) => file.path !== AGENT_GRAPH_CLI_PATH), ...extra.files],
    envs: { ...base.envs, ...extra.envs },
    localEnvs: { ...base.localEnvs, ...extra.localEnvs },
  };
}

/** Best-effort: a graph-tool failure must never block a code session. */
export async function withAgentGraphWorkspace(
  base: UserUiWorkspace | null,
  input: AgentGraphSessionInput
): Promise<UserUiWorkspace | null> {
  if (!input.userId) return base;
  try {
    const graph = await prepareAgentGraphWorkspace({ ...input, userId: input.userId });
    log.info('Prepared rose-agents workspace', {
      agentId: input.ownerAgentId,
      sessionId: input.sessionId,
      ok: graph !== null,
    });
    return mergeWorkspaces(base, graph);
  } catch (err) {
    log.error('Failed to prepare rose-agents workspace', {
      agentId: input.ownerAgentId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return base;
  }
}
