import { useMemo, useCallback } from 'react';
import { useAgentTree, filterTreeBySpawn, indexTreeChildren, type TreeNode } from '../../hooks';
import { summarizeTree, extractEmoji, makePendingNode } from '../subAgentTree.helpers';

const GOAL_MAX_CHARS = 80;
const NO_CHILDREN: TreeNode[] = [];

/**
 * Derives all tree-shape data the SubAgentTree renderer needs from the raw
 * node map returned by `useAgentTree`. Keeping this logic in a hook keeps
 * the main component focused on layout.
 */
export function useSubAgentTreeData(busId: string, subAgentIds: string[]) {
  const allNodes = useAgentTree(busId);

  const relevantNodes = useMemo(
    () => filterTreeBySpawn(allNodes, subAgentIds),
    [allNodes, subAgentIds],
  );

  // Indexed once per tree update; every walk and rendered row is a lookup.
  const childIndex = useMemo(() => indexTreeChildren(relevantNodes.values()), [relevantNodes]);
  const getChildren = useCallback(
    (parentId: string): TreeNode[] => childIndex.get(parentId) ?? NO_CHILDREN,
    [childIndex],
  );

  // Drive roots off the known subAgentIds, not off whichever nodes have arrived.
  // Any id without real node data yet renders as a pending placeholder so the
  // spawn tree is visible immediately; bus/REST data replaces it by agentId.
  const rootNodes = useMemo(
    () => subAgentIds.map((id) => relevantNodes.get(id) ?? makePendingNode(id)),
    [relevantNodes, subAgentIds],
  );

  const { leafNodes, intermediaryNodes, maxDepth } = useMemo(
    () => summarizeTree(rootNodes, getChildren),
    [rootNodes, getChildren],
  );

  const goalsList = useMemo(
    () =>
      rootNodes.map((node) => {
        const { text } = extractEmoji(node.goal);
        return text.length > GOAL_MAX_CHARS ? text.slice(0, GOAL_MAX_CHARS - 3) + '...' : text;
      }),
    [rootNodes],
  );

  return {
    // Loaded nodes (roots + descendants) plus each still-pending root that has
    // no node data yet, so a mixed loaded/pending tree isn't undercounted.
    totalAgents: relevantNodes.size + subAgentIds.filter((id) => !relevantNodes.has(id)).length,
    rootNodes,
    maxDepth,
    leafNodes,
    intermediaryNodes,
    goalsList,
    getChildren,
  };
}
