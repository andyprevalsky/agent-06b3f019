/**
 * Code agents (Claude Code / Codex sessions) for the Rose left bar.
 *
 * Each bar row is a tree root (busId = root agent id); GET /api/agents/tree
 * lists that tree's sessions in `code_agents`, and the bar shows them under
 * the row they belong to (sessions owned by a sub-agent sit under its root).
 *
 * Bounded at any agent count: at most MAX_CODE_AGENT_TREES trees are read —
 * the selected row plus the first rows in display order. Running rows refresh
 * every 30s while the bar is mounted; finished rows are read once and kept
 * fresh for 5 minutes. A batched list-level contract would replace the
 * per-row reads.
 */

import { useQueries } from '@tanstack/react-query';

import { fetchTreeCodeAgents, type CodeAgentNode } from '@/lib/api/tree';

import { agentRunStatus } from '../agentRunState';
import type { Agent } from '../../hooks';

export const MAX_CODE_AGENT_TREES = 20;
const RUNNING_REFRESH_MS = 30_000;
const FINISHED_STALE_MS = 5 * 60_000;

const NO_CODE_AGENTS: readonly CodeAgentNode[] = [];

interface TreeRoot {
  agentId: string;
  running: boolean;
}

function pickRoots(agents: Agent[], selectedAgentId: string | null): TreeRoot[] {
  const ordered = [...agents];
  const selected = ordered.findIndex((a) => a.agent_id === selectedAgentId);
  if (selected >= MAX_CODE_AGENT_TREES) ordered.unshift(...ordered.splice(selected, 1));
  return ordered.slice(0, MAX_CODE_AGENT_TREES).map((agent) => ({
    agentId: agent.agent_id,
    running: agentRunStatus(agent).state === 'active',
  }));
}

/** Code agents under each bar row, oldest first; rows without any map to []. */
export function useRoseCodeAgents(
  agents: Agent[],
  selectedAgentId: string | null,
): (agentId: string) => readonly CodeAgentNode[] {
  const roots = pickRoots(agents, selectedAgentId);
  const byRoot = useQueries({
    queries: roots.map((root) => ({
      queryKey: ['rose-code-agents', root.agentId],
      queryFn: () => fetchTreeCodeAgents(root.agentId),
      staleTime: root.running ? RUNNING_REFRESH_MS : FINISHED_STALE_MS,
      refetchInterval: root.running ? RUNNING_REFRESH_MS : (false as const),
      retry: false,
    })),
    combine: (results) => {
      const map = new Map<string, CodeAgentNode[]>();
      results.forEach((result, i) => {
        const rows = result.data ?? [];
        if (rows.length === 0) return;
        const sorted = [...rows].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        map.set(roots[i].agentId, sorted);
      });
      return map;
    },
  });
  return (agentId) => byRoot.get(agentId) ?? NO_CODE_AGENTS;
}
