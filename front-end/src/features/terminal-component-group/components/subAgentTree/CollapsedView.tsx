import { type TreeNode } from '../../hooks';
import { TREE_LAST, isTerminalNode } from '../subAgentTree.helpers';
import { CollapsedHeader } from './TreeHeader';
import { IntermediaryLine, CompletedLine } from './SummaryLines';
import { LeafNodeRow } from './LeafNodeRow';

interface CollapsedViewProps {
  clusterCircle: string;
  clusterTitle: string;
  totalAgents: number;
  allTerminal: boolean;
  anyFailed: boolean;
  goalsList: string[];
  leafNodes: TreeNode[];
  intermediaryNodes: TreeNode[];
  hideHeader: boolean;
  showCompletedNodes: boolean;
  setShowCompletedNodes: (v: boolean) => void;
  onShowAllIntermediaries: () => void;
  onNavigate: (agentId: string) => void;
}

/**
 * Collapsed variant of SubAgentTree: shown when maxDepth >= 2 and the user
 * has not explicitly expanded the intermediary nodes.
 */
export function CollapsedView({
  clusterCircle,
  clusterTitle,
  totalAgents,
  allTerminal,
  anyFailed,
  goalsList,
  leafNodes,
  intermediaryNodes,
  hideHeader,
  showCompletedNodes,
  setShowCompletedNodes,
  onShowAllIntermediaries,
  onNavigate,
}: CollapsedViewProps) {
  const terminalLeafNodes = leafNodes.filter(isTerminalNode);
  const activeLeafNodes = leafNodes.filter((n) => !isTerminalNode(n));
  const visibleActiveLeafNodes = activeLeafNodes.slice(0, 1);
  const showTerminalSummary = terminalLeafNodes.length > 1 && !showCompletedNodes;
  const leavesToShow = showTerminalSummary
    ? visibleActiveLeafNodes
    : [...visibleActiveLeafNodes, ...terminalLeafNodes];

  return (
    <div className="font-mono text-sm">
      {!hideHeader && (
        <CollapsedHeader
          circle={clusterCircle}
          title={clusterTitle}
          totalAgents={totalAgents}
          allTerminal={allTerminal}
          anyFailed={anyFailed}
          goalsList={goalsList}
        />
      )}
      {intermediaryNodes.length > 0 && (
        <IntermediaryLine
          count={intermediaryNodes.length}
          allTerminal={allTerminal}
          onShowAll={onShowAllIntermediaries}
        />
      )}
      {leavesToShow.map((node, index) => {
        const isLastLeaf = index === leavesToShow.length - 1;
        const isLast = isLastLeaf && !showTerminalSummary;
        return (
          <LeafNodeRow
            key={node.agentId}
            node={node}
            isLast={isLast}
            prefix="      "
            onNavigate={onNavigate}
          />
        );
      })}
      {showTerminalSummary && (
        <CompletedLine
          count={terminalLeafNodes.length}
          onShowAll={() => setShowCompletedNodes(true)}
        />
      )}
      {terminalLeafNodes.length > 1 && showCompletedNodes && (
        <div
          className="flex items-center gap-1 py-0.5 cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          onClick={() => setShowCompletedNodes(false)}
        >
          <span className="whitespace-pre select-none"> </span>
          <span className="text-gray-400 dark:text-gray-600 whitespace-pre select-none flex-shrink-0">
            {TREE_LAST}
          </span>
          <span className="text-xs">← Collapse {terminalLeafNodes.length} finished</span>
        </div>
      )}
    </div>
  );
}
