/**
 * STATE MACHINE: SubAgentTree
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false (shows just agent title)
 *     |
 *     | (click)
 *     v
 * [EXPANDED] <-- isExpanded: true (shows full tree with children)
 *     |
 *     | (click)
 *     v
 * [COLLAPSED]
 *
 * OUTPUT CHIP STATE (per agent with output):
 * [HIDDEN] <-- showOutput: false
 *     |
 *     v (click JSON button)
 * [VISIBLE] <-- showOutput: true (shows formatted JSON output)
 *
 * Tree data comes from useAgentTree hook via AgentContext.
 * Visual state (circle color, status text) derived from agent status.
 * Aggregate copy is user-facing and intentionally avoids tool names.
 */

import { memo, useState } from 'react';
import { isTerminalNode } from './subAgentTree.helpers';
import { useSubAgentTreeData } from './subAgentTree/useSubAgentTreeData';
import { CollapsedView } from './subAgentTree/CollapsedView';
import { FullTreeView } from './subAgentTree/FullTreeView';

interface SubAgentTreeProps {
  busId: string;
  subAgentIds: string[];
  onNavigate: (agentId: string) => void;
  /** Hide the header line (used when consecutive trees are grouped) */
  hideHeader?: boolean;
}

/**
 * Tree-style display of sub-agents spawned by a spawn_sub_agent tool call.
 *
 * Renders a DAG visualization using tree drawing characters and circle progress states.
 * For trees of depth >= 2, collapses intermediary nodes and only shows leaf nodes,
 * with a clickable "X intermediary agents" line.
 */
const SubAgentTree = memo(function SubAgentTree({
  busId,
  subAgentIds,
  onNavigate,
  hideHeader = false,
}: SubAgentTreeProps) {
  const [showAllIntermediaries, setShowAllIntermediaries] = useState(true);
  const [showCompletedNodes, setShowCompletedNodes] = useState(false);

  const { totalAgents, rootNodes, maxDepth, leafNodes, intermediaryNodes, goalsList, getChildren } =
    useSubAgentTreeData(busId, subAgentIds);

  if (rootNodes.length === 0) return null;

  const allTerminal = leafNodes.length > 0 && leafNodes.every(isTerminalNode);
  const anyFailed = leafNodes.some((node) => node.status === 'FAILED');
  const clusterCircle = allTerminal ? (anyFailed ? '✗' : '●') : '◑';
  const failedCount = leafNodes.filter((node) => node.status === 'FAILED').length;
  const clusterTitle = allTerminal
    ? failedCount === 0
      ? 'Sub Agents completed successfully'
      : failedCount === leafNodes.length
        ? 'All Sub Agents failed'
        : 'Some Sub Agents failed'
    : 'Delegating Sub Agents';

  const shouldCollapse = maxDepth >= 2 && !showAllIntermediaries;

  if (shouldCollapse) {
    return (
      <CollapsedView
        clusterCircle={clusterCircle}
        clusterTitle={clusterTitle}
        totalAgents={totalAgents}
        allTerminal={allTerminal}
        anyFailed={anyFailed}
        goalsList={goalsList}
        leafNodes={leafNodes}
        intermediaryNodes={intermediaryNodes}
        hideHeader={hideHeader}
        showCompletedNodes={showCompletedNodes}
        setShowCompletedNodes={setShowCompletedNodes}
        onShowAllIntermediaries={() => setShowAllIntermediaries(true)}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <FullTreeView
      clusterCircle={clusterCircle}
      clusterTitle={clusterTitle}
      totalAgents={totalAgents}
      allTerminal={allTerminal}
      anyFailed={anyFailed}
      rootNodes={rootNodes}
      intermediaryNodes={intermediaryNodes}
      hideHeader={hideHeader}
      canCollapseIntermediaries={showAllIntermediaries}
      onCollapseIntermediaries={() => setShowAllIntermediaries(false)}
      getChildren={getChildren}
      onNavigate={onNavigate}
    />
  );
});

export default SubAgentTree;
