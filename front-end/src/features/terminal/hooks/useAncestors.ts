/**
 * Terminal feature — ancestor chain hook.
 *
 *   API_CHAIN — GET /ancestors (live Agent CTE, root first)
 *   TREE_WALK — hub / archived GPs: CTE is empty; GET /tree already serves
 *               the hub fan-out (parent_agent_id + goal), same as live runs
 *   PARENT_FETCH — tree empty: GET /agents/:parentId for the parent goal
 *   PARENT_GOAL — agent detail already has parent_goal
 *
 * Result is parent > … so SubAgentBreadcrumb can render the live-run trail.
 *
 * FETCH IDENTITY: one GET /ancestors per (agent, parent link). An agent's
 * detail arriving turns parent_agent_id/parent_goal from undefined (not loaded)
 * into null (root) — the same link, so that transition must not refetch.
 */

import { useEffect, useState } from 'react';

import { fetchAncestors as fetchAncestorsAPI } from '../api';
import { fetchTreeState, getAgent } from '@/lib/api';
import type { AncestorNode } from '../types';

function walkTreeAncestors(
  agentId: string,
  nodes: Array<{ agent_id: string; parent_agent_id: string | null; goal: string }>,
): AncestorNode[] {
  const byId = new Map(nodes.map((node) => [node.agent_id, node]));
  const chain: AncestorNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(agentId);
  while (current?.parent_agent_id && !seen.has(current.parent_agent_id)) {
    seen.add(current.parent_agent_id);
    const parent = byId.get(current.parent_agent_id);
    if (!parent) break;
    chain.push({ id: parent.agent_id, goal: parent.goal });
    current = parent;
  }
  return chain.reverse();
}

async function resolveHubAncestors(
  agentId: string,
  parentAgentId: string | null | undefined,
  parentGoal: string | null | undefined,
): Promise<AncestorNode[]> {
  if (!parentAgentId) return [];
  if (parentGoal) return [{ id: parentAgentId, goal: parentGoal }];
  try {
    const tree = await fetchTreeState(parentAgentId);
    const walked = walkTreeAncestors(agentId, tree);
    if (walked.length > 0) return walked;
  } catch {
    /* parent GET is the next fallback */
  }
  try {
    const detail = await getAgent(parentAgentId);
    return [{ id: parentAgentId, goal: detail.agent.goal || 'parent' }];
  } catch {
    return [{ id: parentAgentId, goal: 'parent' }];
  }
}

export function useAncestors(
  selectedAgentId: string | null,
  parentAgentId?: string | null,
  parentGoal?: string | null,
): AncestorNode[] {
  const [resolved, setResolved] = useState<{
    agentId: string | null;
    ancestors: AncestorNode[];
  }>({ agentId: null, ancestors: [] });

  // undefined (detail not loaded) and null (root) are the same parent link.
  const parentId = parentAgentId ?? null;
  const parentGoalText = parentGoal ?? null;
  useEffect(() => {
    if (!selectedAgentId) {
      setResolved({ agentId: null, ancestors: [] });
      return;
    }
    let active = true;
    fetchAncestorsAPI(selectedAgentId)
      .then(async (result) => {
        if (!active) return;
        if (result.length > 0) {
          setResolved({ agentId: selectedAgentId, ancestors: result });
          return;
        }
        const ancestors = await resolveHubAncestors(selectedAgentId, parentId, parentGoalText);
        if (active) setResolved({ agentId: selectedAgentId, ancestors });
      })
      .catch(async () => {
        if (!active) return;
        const ancestors = await resolveHubAncestors(selectedAgentId, parentId, parentGoalText);
        if (active) setResolved({ agentId: selectedAgentId, ancestors });
      });
    return () => {
      active = false;
    };
  }, [selectedAgentId, parentId, parentGoalText]);

  return resolved.agentId === selectedAgentId ? resolved.ancestors : [];
}
