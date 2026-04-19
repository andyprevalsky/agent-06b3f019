import { type TreeNode } from '../../hooks';
import { TREE_BRANCH } from '../subAgentTree.helpers';
import { TreeHeader } from './TreeHeader';
import { TreeNodeRow } from './TreeNodeRow';

interface FullTreeViewProps {
  clusterCircle: string;
  clusterTitle: string;
  totalAgents: number;
  allTerminal: boolean;
  anyFailed: boolean;
  rootNodes: TreeNode[];
  intermediaryNodes: TreeNode[];
  hideHeader: boolean;
  canCollapseIntermediaries: boolean;
  onCollapseIntermediaries: () => void;
  getChildren: (parentId: string) => TreeNode[];
  onNavigate: (agentId: string) => void;
}

/**
 * Full tree variant of SubAgentTree: shown when maxDepth < 2 or the user
 * has expanded the intermediary nodes.
 */
export function FullTreeView({
  clusterCircle,
  clusterTitle,
  totalAgents,
  allTerminal,
  anyFailed,
  rootNodes,
  intermediaryNodes,
  hideHeader,
  canCollapseIntermediaries,
  onCollapseIntermediaries,
  getChildren,
  onNavigate,
}: FullTreeViewProps) {
  return (
    <div className="font-mono text-sm">
      {!hideHeader && (
        <TreeHeader
          circle={clusterCircle}
          title={clusterTitle}
          totalAgents={totalAgents}
          allTerminal={allTerminal}
          anyFailed={anyFailed}
        />
      )}
      {canCollapseIntermediaries && intermediaryNodes.length > 0 && (
        <div
          className="flex items-center gap-1 py-0.5 cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          onClick={onCollapseIntermediaries}
        >
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none">
            {TREE_BRANCH}
          </span>
          <span className="text-xs">← Collapse intermediary agents</span>
        </div>
      )}
      {rootNodes.map((node, index) => (
        <TreeNodeRow
          key={node.agentId}
          node={node}
          isLast={index === rootNodes.length - 1}
          prefix=""
          getChildren={getChildren}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
