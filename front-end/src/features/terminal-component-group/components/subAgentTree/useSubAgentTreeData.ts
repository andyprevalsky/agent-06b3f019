import { useMemo, useCallback } from 'react';
import { useAgentTree, filterTreeBySpawn, type TreeNode } from '../../hooks';
import {
  getLeafNodes,
  getIntermediaryNodes,
  getTreeDepth,
  extractEmoji,
} from '../subAgentTree.helpers';

const GOAL_MAX_CHARS = 80;

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

  const getChildren = useCallback(
    (parentId: string): TreeNode[] => {
      const children: TreeNode[] = [];
      for (const node of relevantNodes.values()) {
        if (node.parentAgentId === parentId) {
          children.push(node);
        }
      }
      return children;
    },
    [relevantNodes],
  );

  const rootNodes = useMemo(
    () =>
      subAgentIds
        .map((id) => relevantNodes.get(id))
        .filter((node): node is TreeNode => node !== undefined),
    [relevantNodes, subAgentIds],
  );

  const maxDepth = useMemo(() => {
    if (rootNodes.length === 0) return 0;
    return Math.max(...rootNodes.map((node) => getTreeDepth(node, getChildren)));
  }, [rootNodes, getChildren]);

  const { leafNodes, intermediaryNodes } = useMemo(() => {
    const leaves: TreeNode[] = [];
    const intermediaries: TreeNode[] = [];
    for (const root of rootNodes) {
      leaves.push(...getLeafNodes(root, getChildren));
      const rootChildren = getChildren(root.agentId);
      if (rootChildren.length > 0) {
        intermediaries.push(root);
      }
      intermediaries.push(...getIntermediaryNodes(root, getChildren));
    }
    return { leafNodes: leaves, intermediaryNodes: intermediaries };
  }, [rootNodes, getChildren]);

  const goalsList = useMemo(
    () =>
      rootNodes.map((node) => {
        const { text } = extractEmoji(node.goal);
        return text.length > GOAL_MAX_CHARS ? text.slice(0, GOAL_MAX_CHARS - 3) + '...' : text;
      }),
    [rootNodes],
  );

  return {
    totalAgents: relevantNodes.size,
    rootNodes,
    maxDepth,
    leafNodes,
    intermediaryNodes,
    goalsList,
    getChildren,
  };
}
