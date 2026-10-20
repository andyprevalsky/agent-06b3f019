/**
 * Code agents (Claude Code / Codex sessions) for the agents list, batched by
 * root: GET /api/agents/code-agents?root_ids=<ids>.
 *
 * One indexed join per request over the caller's requested trees (at most
 * CODE_AGENT_LIST_MAX_ROOTS), so the cost grows with the roots asked for,
 * never with all of the user's agents.
 */
import { z } from 'zod';
import {
  CODE_AGENT_LIST_MAX_ROOTS,
  listCodeAgentsForRoots,
  type GraphCodeSessionRow,
} from './repoGraph';

export const codeAgentsQuerySchema = z.object({
  root_ids: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().uuid()).min(1).max(CODE_AGENT_LIST_MAX_ROOTS)),
});

export type CodeAgentProvider = 'claude' | 'codex' | null;

/** The CLI a code agent ran; null for legacy rows that never recorded it. */
export function codeAgentProvider(
  row: Pick<GraphCodeSessionRow, 'codeProvider'>
): CodeAgentProvider {
  return row.codeProvider === 'claude' || row.codeProvider === 'codex' ? row.codeProvider : null;
}

export interface CodeAgentListItem {
  code_agent_id: string;
  owner_agent_id: string;
  root_agent_id: string;
  provider: CodeAgentProvider;
  status: string;
  /** First line of the goal. */
  title: string;
  created_at: Date;
}

export async function listCodeAgents(
  userId: string,
  rootIds: string[]
): Promise<{ code_agents: CodeAgentListItem[] }> {
  const rows = await listCodeAgentsForRoots(userId, [...new Set(rootIds)]);
  return {
    code_agents: rows.map((row) => ({
      code_agent_id: row.id,
      owner_agent_id: row.agentId,
      root_agent_id: row.rootAgentId,
      provider: codeAgentProvider(row),
      status: row.status,
      title: (row.goal.split('\n').find((line) => line.trim() !== '') ?? '').trim(),
      created_at: row.createdAt,
    })),
  };
}
