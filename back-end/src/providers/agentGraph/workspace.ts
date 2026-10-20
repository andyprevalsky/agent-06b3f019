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
 * E2B and the local fallback write and PATH it the same way.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import type { UserUiWorkspace } from '../userUi/workspace';
import { AGENT_GRAPH_CLI_NAME, AGENT_GRAPH_CLI_SCRIPT } from './cli';
import { mintAgentGraphToken } from './token';

const log = createLogger('AgentGraphWorkspace');

const CLI_BIN_DIR = '.rose/bin';
const MAX_ROOT_WALK = 64;
export const AGENT_GRAPH_ROUTE_PREFIX = '/api/agent-graph';

export interface AgentGraphSessionInput {
  userId: string | undefined;
  ownerAgentId: string;
  sessionId: string;
  provider: 'claude' | 'codex';
}

function publicBaseUrl(): string {
  const configured =
    process.env.ROSE_AGENTS_BASE_URL ??
    process.env.ROSE_UI_PUBLISH_BASE_URL ??
    process.env.BACKEND_URL ??
    process.env.RENDER_EXTERNAL_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3001}`;
}

async function findRootAgentId(agentId: string, userId: string): Promise<string | null> {
  let currentId: string | null = agentId;
  let rootId: string | null = null;
  const seen = new Set<string>();
  while (currentId !== null && !seen.has(currentId) && seen.size < MAX_ROOT_WALK) {
    seen.add(currentId);
    const row: { parentAgentId: string | null } | null = await prisma.agent.findFirst({
      where: { id: currentId, userId },
      select: { parentAgentId: true },
    });
    if (row === null) break;
    rootId = currentId;
    currentId = row.parentAgentId;
  }
  return rootId;
}

export async function prepareAgentGraphWorkspace(
  input: AgentGraphSessionInput & { userId: string }
): Promise<UserUiWorkspace | null> {
  const rootAgentId = await findRootAgentId(input.ownerAgentId, input.userId);
  if (rootAgentId === null) return null;
  const { token } = mintAgentGraphToken({
    sub: input.userId,
    rootAgentId,
    ownerAgentId: input.ownerAgentId,
    sessionId: input.sessionId,
    provider: input.provider,
  });
  return {
    files: [
      {
        path: `${CLI_BIN_DIR}/${AGENT_GRAPH_CLI_NAME}`,
        content: Buffer.from(AGENT_GRAPH_CLI_SCRIPT, 'utf8'),
      },
    ],
    envs: {
      ROSE_AGENTS_URL: `${publicBaseUrl()}${AGENT_GRAPH_ROUTE_PREFIX}`,
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
    files: [...base.files, ...extra.files],
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
