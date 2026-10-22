import { useEffect, useState } from 'react';
import { listenToAgentTree, type TreeNode } from './agentTreeSubscription';

export type { TreeNode, TreeBackgroundTask } from './agentTreeSubscription';

const EMPTY_TREE_SOURCE = new Map<string, TreeNode>();
const EMPTY_TREE = new Proxy(EMPTY_TREE_SOURCE, {
  get(target, property) {
    if (property === 'set' || property === 'delete' || property === 'clear') {
      return () => {
        throw new TypeError('The shared empty agent tree is read-only');
      };
    }
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as ReadonlyMap<string, TreeNode>;

/**
 * Subscribe to the shared sub-agent tree for one root bus.
 *
 * The shared transport is generation-owned by the bus entry. This hook owns
 * only its listener, whose final React setter verifies the live bus identity.
 */
export function useAgentTree(busId: string | null): ReadonlyMap<string, TreeNode> {
  const [treeState, setTreeState] = useState<{
    busId: string | null;
    nodes: ReadonlyMap<string, TreeNode>;
  }>({ busId, nodes: EMPTY_TREE });
  useEffect(() => {
    if (!busId) return;
    return listenToAgentTree(busId, (nodes) => {
      // Publisher replaces maps rather than mutating them; retain that immutable snapshot.
      setTreeState({ busId, nodes });
    });
  }, [busId]);

  return treeState.busId === busId ? treeState.nodes : EMPTY_TREE;
}

/**
 * Group tree nodes by `parentAgentId` in one pass, keeping map order within
 * each parent. Tree walks look children up here instead of rescanning every
 * node per visit (O(nodes), not O(nodes²), for a 10k-agent tree).
 */
export function indexTreeChildren(nodes: Iterable<TreeNode>): Map<string, TreeNode[]> {
  const index = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const parentId = node.parentAgentId;
    if (!parentId) continue;
    const siblings = index.get(parentId);
    if (siblings) siblings.push(node);
    else index.set(parentId, [node]);
  }
  return index;
}

/** Filter tree nodes to the named spawn roots and all their descendants (BFS order). */
export function filterTreeBySpawn(
  allNodes: ReadonlyMap<string, TreeNode>,
  subAgentIds: string[],
): Map<string, TreeNode> {
  const relevant = new Map<string, TreeNode>();
  const queue = subAgentIds.filter((id) => allNodes.has(id));
  if (queue.length === 0) return relevant;
  const children = indexTreeChildren(allNodes.values());

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const node = allNodes.get(id);
    if (!node || relevant.has(id)) continue;
    relevant.set(id, node);
    for (const child of children.get(id) ?? []) {
      if (!relevant.has(child.agentId)) queue.push(child.agentId);
    }
  }

  return relevant;
}

/** Return the compact progress glyph for a tree node. */
export function getCircleState(node: TreeNode): string {
  if (node.status === 'COMPLETED') return '●';
  if (node.status === 'FAILED') return '✗';
  if (node.status === 'OUT_OF_CREDITS') return '⊘';
  if (node.status === 'COST_LIMIT_REACHED') return '◎';
  if (node.progress >= 0.7) return '◕';
  if (node.progress > 0 && node.progress < 0.3) return '◔';
  if (node.messageCount > 0 && node.progress === 0) return '◑';
  return '○';
}

/** Return the human-readable nonterminal status for a tree node. */
export function getStatusText(node: TreeNode): string {
  if (node.status === 'COMPLETED') return '';
  if (node.status === 'FAILED') return 'failed';
  if (node.status === 'PAUSED') return 'paused';
  if (node.status === 'OUT_OF_CREDITS') return 'out of credits';
  if (node.status === 'COST_LIMIT_REACHED') return 'cost limit reached';
  if (node.status === 'STARTING_UP') return 'spinning up...';
  if (node.messageCount === 0) return 'spinning up...';
  if (node.toolsInUse.length === 0) return 'thinking...';
  if (node.toolsInUse.length === 1) return node.toolsInUse[0];
  return `Using ${node.toolsInUse.length} tools`;
}
