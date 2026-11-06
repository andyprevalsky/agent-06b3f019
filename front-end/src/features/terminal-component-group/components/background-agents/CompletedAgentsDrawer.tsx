/**
 * STATE MACHINE: CompletedAgentsDrawer (finished agents of one dock group)
 *
 * [HIDDEN]    the group has no finished (COMPLETED/FAILED) agents
 *     | an agent finishes
 *     v
 * [COLLAPSED] (default) "▸ X completed agents, Y succeeded, Z failed"
 *     | click                     ^ click
 *     v                           |
 * [EXPANDED]  "▾ …" then every finished agent as a TreeNodeRow at the group's
 *             own level (prefix "", same as the running rows above it)
 */
import { useState, type ReactNode } from 'react';
import type { TreeNode } from '../../hooks';
import { TREE_BRANCH, TREE_LAST } from '../subAgentTree.helpers';
import { TreeNodeRow } from '../subAgentTree/TreeNodeRow';

interface CompletedAgentsDrawerProps {
  nodes: TreeNode[];
  getChildren: (parentId: string) => TreeNode[];
  onNavigate: (agentId: string) => void;
  renderAfterNode?: (node: TreeNode, childPrefix: string) => ReactNode;
}

function completedSummary(nodes: TreeNode[]): string {
  const failed = nodes.filter((node) => node.status === 'FAILED').length;
  const total = nodes.length;
  return `${total} completed agent${total === 1 ? '' : 's'}, ${total - failed} succeeded, ${failed} failed`;
}

export function CompletedAgentsDrawer({
  nodes,
  getChildren,
  onNavigate,
  renderAfterNode,
}: CompletedAgentsDrawerProps) {
  const [open, setOpen] = useState(false);
  if (nodes.length === 0) return null;
  return (
    <div className="min-w-0" data-testid="agent-panel-completed">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded py-0.5 text-left text-gray-500 hover:bg-gray-100 dark:hover:bg-[#2f2f2c]"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="agent-panel-completed-toggle"
      >
        <span className="whitespace-pre select-none text-gray-400 dark:text-gray-600">
          {open ? TREE_BRANCH : TREE_LAST}
        </span>
        <span className="w-4 shrink-0 text-center select-none">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate">{completedSummary(nodes)}</span>
      </button>
      {open &&
        nodes.map((node, index) => (
          <TreeNodeRow
            key={node.agentId}
            node={node}
            isLast={index === nodes.length - 1}
            prefix=""
            getChildren={getChildren}
            onNavigate={onNavigate}
            renderAfterNode={renderAfterNode}
          />
        ))}
    </div>
  );
}
